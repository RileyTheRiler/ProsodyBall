// ============================================================
// VoiceAnalyzer — real-time voice/prosody DSP pipeline.
// Extracted from app.js so the analysis core can be unit-tested
// headlessly (it has no DOM/controller dependencies).
// ============================================================
import {
  clamp01,
  computeFrameReliability,
  normalizeAgainstPercentiles,
  normalizeAgainstRange,
  computeWeightTarget,
  computeAttackHardness,
  computeSpectralCentroid,
  computeFormantDispersion,
  computeCepstrum,
  computeCPP,
  correctOctaveError
} from "./dsp-utils.js";

// ============================================================
// DSP TUNING CONSTANTS
// Centralised so they're easy to find, tweak, and document.
// ============================================================
const YIN_THRESHOLD = 0.15;               // CMND threshold for pitch detection (lower = stricter)
const PITCH_CONFIDENCE_FACTOR = 3.3;      // Maps CMND → confidence: conf = 1 - cmnd * factor
const INTONATION_ST_DIVISOR = 6.0;        // Semitone std-dev mapped to [0,1] bounce (0–1 ST flat, 2–4 conversational, 4–6 expressive)
const TEMPO_TRANSITION_DIVISOR = 12;      // Energy crossings → [0,1] tempo
const VOWEL_ONSET_SECS = 0.15;           // Seconds of sustain before vowel metric starts rising (sustain/diagnostic mode)
const VOWEL_SATURATION_SECS = 0.6;       // Additional seconds to reach vowel = 1.0 (sustain/diagnostic mode)
const VOWEL_DECAY_RATE = 0.85;           // Per-frame decay multiplier when not vowel-like (sustain mode)
const VOWEL_CONNECTED_ONSET_SECS = 0.05; // Onset delay for connected-speech mode
const VOWEL_CONNECTED_SATURATION_SECS = 0.20; // Saturation time for connected-speech mode
const VOWEL_CONNECTED_DECAY_RATE = 0.92; // Per-frame decay for connected-speech mode
const VOWEL_SUSTAIN_MULT = 0.4;          // Energy percentile multiplier for vowel detection threshold
const ARTIC_SENSITIVITY_GAIN = 1.2;      // Gain applied to articulation normalisation
const SYLLABLE_DEBOUNCE_SECS = 0.08;     // Minimum seconds between syllable onsets
const SYLLABLE_ON_MULT = 0.6;            // Energy range multiplier for syllable-on threshold
const SYLLABLE_OFF_MULT = 0.15;          // Energy range multiplier for syllable-off threshold
const SYLLABLE_IMPULSE_DECAY = 0.88;     // Per-frame decay of syllable impulse
const WEIGHT_TILT_BASE = 0.45;           // Baseline blend weight for spectral-tilt heaviness
const WEIGHT_H1H2_BLEND = 0.25;          // Max blend weight for the H1-H2 breathiness cue (× confidence)
const WEIGHT_CPP_BLEND = 0.30;           // Blend weight for CPP breathiness cue (× confidence); source-only, no filter contamination
export const H1H2_HEAVY_DB = -2;                // H1-H2 (dB) anchor for pressed/heavy phonation
export const H1H2_LIGHT_DB = 14;                // H1-H2 (dB) anchor for breathy/light phonation
const WEIGHT_SMOOTH_BASE = 0.10;         // Base EMA rate toward the weight target
const ATTACK_RISE_WINDOW_SECS = 0.06;    // Capture peak energy-rise within 60ms of an onset
const ATTACK_IMPULSE_DECAY = 0.90;       // Per-frame decay of the vocal-attack impulse
const ATTACK_RISE_LEARN_RATE = 0.02;     // EMA rate for the adaptive rise-rate ceiling
const ATTACK_ABRUPT_BLEND = 0.30;        // Blend weight for onset-abruptness vs amplitude-rise hardness

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

    // Resonance — LPC (Levinson-Durbin + root-solving) formant estimation.
    // Default chosen empirically: against synthetic vowels with known formants,
    // LPC has ~14 Hz mean F1/F2 error vs. ~358 Hz for 'harmonic' (see
    // tools/eval-formant-methods.mjs). It is gated to confident voiced vowels,
    // so its ~0.13 ms/call cost is negligible. The Kalman stage already trusts
    // LPC most. Other methods remain available for comparison/diagnostics.
    this.resonanceMethod = 'lpc'; // 'harmonic' | 'cepstral' | 'lpc' | 'centroid'
    this.smoothResonance = 0.5; // 0=low/dark resonance, 1=high/bright resonance
    this.smoothF1 = 500;        // smoothed F1 estimate (Hz)
    this.smoothF2 = 1500;       // smoothed F2 estimate (Hz) — primary resonance correlate
    this.smoothF3 = 2700;       // smoothed F3 estimate (Hz) — secondary resonance cue
    this.formantConfidence = 0;  // how reliable current F1/F2/F3 estimates are
    this.vowelLikelihood = 0;   // 0=not vowel-like, 1=strong vowel formants

    // ====== PERCEIVED-GENDER CUES (multi-cue model) ======
    // Modal (habitual median) pitch over a voiced window, not the momentary note.
    this.modalF0Buf = [];
    this.modalF0BufMax = 90;     // ~1.5s of voiced frames
    this.modalF0Hz = 0;
    this.modalF0Confidence = 0;
    // Sibilant /s/ center-of-gravity (higher = shorter front cavity = feminine).
    this.sibilantCentroidHz = 0;
    this.sibilantConfidence = 0;
    // Mean formant spacing (ΔF) -> apparent vocal-tract length.
    this.formantDispersionHz = 0;
    // Cepstral Peak Prominence (breathiness; lower = breathier = feminine).
    this.cppDb = 12;
    this.cppConfidence = 0;
    this._cppFrameCounter = 0;   // CPP runs every Nth frame (cost control)

    // Kalman filters for formants
    const initKalman = () => ({
      x: [0, 0], // [freq, velocity]
      P: [[10000, 0], [0, 1000]],
      Q: [[100, 0], [0, 10]],
      initialized: false
    });
    this._kalmanF1 = initKalman();
    this._kalmanF2 = initKalman();
    this._kalmanF3 = initKalman();

    // Spectral tilt diagnostic (light vs heavy vocal weight)
    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5; // 0=heavy, 1=light
    this.spectralTiltConfidence = 0;
    this.micTiltBaselineDb = 0;
    this.micCalibrationTiltSamples = [];

    // Vocal weight (heaviness, 0=light .. 1=heavy) and vocal attack (onset hardness)
    this.weightSmoothed = 0.5;
    this.prevGatedRms = 0;
    this.attackRisePeak = 0;
    this.attackWindowTimer = -1; // <0 = inactive; >=0 = counting up during capture window
    this.attackRiseCeiling = 0.02;
    this.attackImpulse = 0;
    this.attackPeakTime = 0;     // time (s) into the onset window at which the rise peaked
    this.attackRiseHardness = 0; // latched per-onset rise-rate hardness (display sub-cue)
    this.attackAbruptness = 0;   // latched per-onset onset abruptness (display sub-cue)
    this.h1h2SmoothedDb = 6;     // smoothed H1-H2 (dB); ~6 ≈ modal-voice default → mid weight
    this.h1h2Confidence = 0;     // 0..1 trust in the current H1-H2 estimate

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
    // Ring buffer of recent voiced-segment durations for vowel mode detection.
    this._phonationDurations = [];
    this._phonationDurMax = 20;
    this._currentPhonationStart = -1; // timestamp when current voiced segment began

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

    // Adaptive HF energy tracking (for articulation normalisation)
    this.hfEnergyWindow = [];
    this.hfEnergyWindowMax = 60;
    this.hfPercentiles = { p50: 0, p90: 0.02 };

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
      bounce: 0, vowel: 0,
      articulation: 0,
      pitch: 0, pitchEffort: 0, pitchZone: 0.5,
      energy: 0, resonance: 0,
      attack: 0, weight: 0
    };
    this.pitchZoneLabel = 'Ambiguous';
    this.frameConfidence = 0; // overall frame confidence for game-level gating
    this.wasLastFrameReliable = false;
    this.noiseSpectralProfile = null;
  }

  // Helper to reuse typed arrays to prevent garbage collection spikes in hot loops
  _getBuffer(name, ArrayType, size) {
    if (!this._buffers[name] || this._buffers[name].length < size) {
      this._buffers[name] = new ArrayType(size);
    }
    return this._buffers[name];
  }

  async start(audioFile = null, inputOptions = {}) {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // Kick resume immediately (fire-and-forget) while still in the user-gesture
      // call stack so iOS Safari grants permission to un-suspend the context before
      // getUserMedia breaks the synchronous gesture chain.
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      if (audioFile) {
        // Handle audio file input
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioFile);
        this.audioElement.loop = false;

        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        this.source = this.audioCtx.createMediaElementSource(this.audioElement);
        // Connect to destination so user can hear it
        this.source.connect(this.audioCtx.destination);
      } else if (inputOptions.stream) {
        this.stream = inputOptions.stream;
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
      } else {
        // Handle microphone input
        const requestedConstraints = {
          echoCancellation: inputOptions.echoCancellation !== false,
          noiseSuppression: inputOptions.noiseSuppression !== false,
          autoGainControl: inputOptions.autoGainControl !== false,
        };
        if (inputOptions.deviceId) {
          requestedConstraints.deviceId = { exact: inputOptions.deviceId };
        }
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: requestedConstraints });
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
    // Perceived-gender cue state
    this.modalF0Buf = [];
    this.modalF0Hz = 0;
    this.modalF0Confidence = 0;
    this.sibilantCentroidHz = 0;
    this.sibilantConfidence = 0;
    this.formantDispersionHz = 0;
    this.cppDb = 12;
    this.cppConfidence = 0;
    this._cppFrameCounter = 0;

    const initKalman = () => ({
      x: [0, 0],
      P: [[10000, 0], [0, 1000]],
      Q: [[100, 0], [0, 10]],
      initialized: false
    });
    this._kalmanF1 = initKalman();
    this._kalmanF2 = initKalman();
    this._kalmanF3 = initKalman();

    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5;
    this.spectralTiltConfidence = 0;
    this.micTiltBaselineDb = 0;
    this.micCalibrationTiltSamples = [];
    this.weightSmoothed = 0.5;
    this.prevGatedRms = 0;
    this.attackRisePeak = 0;
    this.attackWindowTimer = -1;
    this.attackRiseCeiling = 0.02;
    this.attackImpulse = 0;
    this.attackPeakTime = 0;
    this.attackRiseHardness = 0;
    this.attackAbruptness = 0;
    this.h1h2SmoothedDb = 6;
    this.h1h2Confidence = 0;
    this.sustainedDuration = 0;
    this._phonationDurations = [];
    this._currentPhonationStart = -1;
    this.pitchZoneLabel = 'Ambiguous';
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
    this.metrics.pitchZone = 0.5;
    this.wasLastFrameReliable = false;
    this.noiseSpectralProfile = null;
  }

  /** Reset calibration state so a fresh calibration can run cleanly */
  resetCalibration() {
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.micCalibrationTiltSamples = [];
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseSpectralProfile = null;
  }

  // Per-bin A-weighting lookup table. The gain for a bin depends only on the bin's
  // centre frequency, which is fixed for a given (sampleRate, fftSize) — computing
  // sqrt/log10/pow for hundreds of bins on every frame is wasted work.
  _aWeightTableFor(fftBinHz, numBins) {
    if (!this._aWeightTable || this._aWeightTable.length !== numBins || this._aWeightTableBinHz !== fftBinHz) {
      const t = new Float32Array(numBins);
      for (let i = 0; i < numBins; i++) t[i] = this._aWeightGain(i * fftBinHz);
      this._aWeightTable = t;
      this._aWeightTableBinHz = fftBinHz;
    }
    return this._aWeightTable;
  }

  // Helper: IEC 61672 A-weighting gain (linear)
  _aWeightGain(freqHz) {
    if (freqHz < 20) return 0.01;
    const f2 = freqHz * freqHz;
    const f4 = f2 * f2;
    const num = 12194 * 12194 * f4;
    const den = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
    const Ra = num / den;
    const A = 20 * Math.log10(Ra) + 2.0;
    return Math.pow(10, A / 10);
  }

  // Helper: 1D Constant-Velocity Kalman Filter Update
  _kalmanUpdate(filter, measurement, measurementNoise) {
    const dt = 1; // 1 frame
    // 1. Predict
    let [x, v] = filter.x;
    let P = filter.P;
    const Q = filter.Q;
    
    if (!filter.initialized) {
      filter.x = [measurement, 0];
      filter.P = [[10000, 0], [0, 1000]];
      filter.initialized = true;
      return measurement;
    }

    // x_pred = F * x
    const x_pred = [x + v * dt, v];
    
    // P_pred = F * P * F^T + Q
    const P_pred = [
      [P[0][0] + dt * P[1][0] + dt * (P[0][1] + dt * P[1][1]) + Q[0][0], P[0][1] + dt * P[1][1] + Q[0][1]],
      [P[1][0] + dt * P[1][1] + Q[1][0], P[1][1] + Q[1][1]]
    ];

    // 2. Update
    // y = z - H * x_pred (H = [1, 0])
    const y = measurement - x_pred[0];
    
    // S = H * P_pred * H^T + R
    const S = P_pred[0][0] + measurementNoise;
    
    // K = P_pred * H^T / S
    const K = [P_pred[0][0] / S, P_pred[1][0] / S];
    
    // x = x_pred + K * y
    filter.x = [x_pred[0] + K[0] * y, x_pred[1] + K[1] * y];
    
    // P = (I - K * H) * P_pred
    filter.P = [
      [(1 - K[0]) * P_pred[0][0], (1 - K[0]) * P_pred[0][1]],
      [-K[1] * P_pred[0][0] + P_pred[1][0], -K[1] * P_pred[0][1] + P_pred[1][1]]
    ];

    return filter.x[0];
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
    // OPTIMIZATION: Use quickselect algorithm to find percentile without fully sorting
    const k = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
    return this._quickselect([...values], k, 0, values.length - 1);
  }

  _quickselect(arr, k, left, right) {
    while (left < right) {
      const pivotIndex = this._partition(arr, left, right);
      if (pivotIndex === k) {
        return arr[k];
      } else if (k < pivotIndex) {
        right = pivotIndex - 1;
      } else {
        left = pivotIndex + 1;
      }
    }
    return arr[k];
  }

  _partition(arr, left, right) {
    const pivot = arr[right];
    let i = left;
    for (let j = left; j < right; j++) {
      if (arr[j] <= pivot) {
        const temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
        i++;
      }
    }
    const temp = arr[i];
    arr[i] = arr[right];
    arr[right] = temp;
    return i;
  }

  detectPitch(precomputedRms) {
    // timeDomainData already populated by update() — no need to re-read
    const buf = this.timeDomainData;
    const n = buf.length;
    const sampleRate = this.audioCtx.sampleRate;

    // RMS gate — reuse the value update() already computed for this frame when
    // provided, instead of re-summing the full 4096-sample buffer.
    let rms = precomputedRms;
    if (!Number.isFinite(rms)) {
      rms = 0;
      for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / n);
    }
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

    // Adjust params for downsampled rate (Adaptive bounds based on voice profile)
    // Add a 15% safety buffer to variations on the frequency scale
    const safeMinHz = Math.max(40, this.pitchProfile.min * 0.85);
    const safeMaxHz = Math.min(600, this.pitchProfile.max * 1.15);

    // Convert safely to period limits (Inverted: Max Hz maps to Min Period)
    const minPeriod = Math.max(2, Math.floor(dsRate / safeMaxHz)); 
    const maxPeriod = Math.min(Math.floor(dsRate / safeMinHz), Math.floor(dsN / 2));
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
    const yinThreshold = YIN_THRESHOLD; // Stricter = more accurate, less sensitive
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

    // Octave-up guard: YIN's first-below-threshold rule can latch onto the 2x harmonic when the
    // fundamental dip is weak (common for deep voices), reporting double the pitch. Recover the
    // true (longer) period when an equally-good-or-better dip exists at a multiple of bestTau.
    bestTau = correctOctaveError(cmnd, bestTau, { maxPeriod });

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
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - cmndAtBest * PITCH_CONFIDENCE_FACTOR));

    // Step 5: Median filter — suppresses octave jumps and transient blips
    // Keep a small buffer of recent raw detections (7 frames so a brief 2-3 frame error can't
    // dominate the median).
    this._pitchMedianBuf.push(rawHz);
    if (this._pitchMedianBuf.length > 7) this._pitchMedianBuf.shift();

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

      this.analyser.getFloatFrequencyData(this.frequencyData);
      if (!this.noiseSpectralProfile) {
        this.noiseSpectralProfile = new Float32Array(this.frequencyData.length);
      }
      const fftBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
      const activeF0 = 160; // Use fixed 160Hz for baseline calibration
      const lowStartHz = Math.max(70, activeF0 * 0.5);
      const lowEndHz = Math.min(2200, activeF0 * 3.5);
      const highStartHz = 2500;
      const highEndHz = Math.min(5000, this.audioCtx.sampleRate * 0.5 - fftBinHz);
      const eps = 1e-12;

      let eLowTilt = 0, eHighTilt = 0;
      const aWeights = this._aWeightTableFor(fftBinHz, this.frequencyData.length);

      for (let i = 0; i < this.frequencyData.length; i++) {
        // Convert Decibels to Linear Magnitude for proper calibration scaling
        const linearMag = Math.pow(10, this.frequencyData[i] / 20);
        this.noiseSpectralProfile[i] += linearMag;

        const freqHz = i * fftBinHz;
        const powerA = linearMag * linearMag * aWeights[i];
        if (freqHz >= lowStartHz && freqHz <= lowEndHz) {
          eLowTilt += powerA;
        } else if (freqHz >= highStartHz && freqHz <= highEndHz) {
          eHighTilt += powerA;
        }
      }

      let rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
      if (isFinite(rawTiltDb)) this.micCalibrationTiltSamples.push(rawTiltDb);

      if (this.noiseCalibrationTimer >= this.noiseCalibrationDuration) {
        const samples = this.noiseCalibrationSamples;
        let sum = 0, sqSum = 0;
        for (let i = 0; i < samples.length; i++) {
          sum += samples[i];
          sqSum += samples[i] * samples[i];
        }
        const mean = sum / samples.length;
        // Optimize standard deviation with single pass: Math.sqrt(E[X^2] - (E[X])^2)
        const std = Math.sqrt(Math.max(0, (sqSum / samples.length) - (mean * mean)));

        // Set floor at mean + 4*std — aggressively above ambient noise (fans, AC, etc)
        this.noiseFloor = Math.max(0.01, mean + std * 4);
        this.syllableThreshold = this.noiseFloor * 1.2;
        this.sustainedThreshold = this.noiseFloor * 1.5;

        // HF noise floor — mean + 2*std of HF energy during silence
        const hfSamples = this.hfCalibrationSamples;
        let hfSum = 0, hfSqSum = 0;
        for (let i = 0; i < hfSamples.length; i++) {
          hfSum += hfSamples[i];
          hfSqSum += hfSamples[i] * hfSamples[i];
        }
        const hfMean = hfSum / hfSamples.length;
        const hfStd = Math.sqrt(Math.max(0, (hfSqSum / hfSamples.length) - (hfMean * hfMean)));

        this.hfNoiseFloor = hfMean + hfStd * 2;
        this.isCalibrated = true;

        if (this.micCalibrationTiltSamples.length > 0) {
          const sorted = [...this.micCalibrationTiltSamples].sort((a, b) => a - b);
          this.micTiltBaselineDb = sorted[Math.floor(sorted.length / 2)];
        }

        // Average the accumulated spectral profile
        if (this.noiseSpectralProfile) {
          for (let i = 0; i < this.noiseSpectralProfile.length; i++) {
            this.noiseSpectralProfile[i] /= this.noiseCalibrationSamples.length;
          }
        }

        console.log(`Noise calibrated: floor=${(this.noiseFloor * 1000).toFixed(1)}mRMS, hfFloor=${this.hfNoiseFloor.toFixed(4)}, micTilt=${this.micTiltBaselineDb.toFixed(1)}dB`);
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
      pitch = this.detectPitch(rms);
    }
    if (pitch > 0) {
      this.lastPitch = pitch;
      this.pitchHistory.push(pitch);
      if (this.pitchHistory.length > this.pitchHistoryMax) this.pitchHistory.shift();
      // --- MODAL (median) F0 over a voiced window — habitual pitch, not the momentary note ---
      if (this.pitchConfidence > 0.4) {
        this.modalF0Buf.push(pitch);
        if (this.modalF0Buf.length > this.modalF0BufMax) this.modalF0Buf.shift();
      }
      if (this.modalF0Buf.length >= 8) {
        const p10 = this._percentile(this.modalF0Buf, 0.10);
        const p50 = this._percentile(this.modalF0Buf, 0.50);
        const p90 = this._percentile(this.modalF0Buf, 0.90);
        this.modalF0Hz = p50;
        const fill = Math.min(1, this.modalF0Buf.length / this.modalF0BufMax);
        const relSpread = p50 > 0 ? (p90 - p10) / (2 * p50) : 1;
        this.modalF0Confidence = Math.max(0, Math.min(1, fill * (1 - relSpread)));
      }
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

    // Track HF energy percentiles for adaptive articulation normalisation
    if (hfEnergy > 0) {
      this.hfEnergyWindow.push(hfEnergy);
      if (this.hfEnergyWindow.length > this.hfEnergyWindowMax) this.hfEnergyWindow.shift();
      if (this.hfEnergyWindow.length >= 8) {
        this.hfPercentiles.p50 = this._percentile(this.hfEnergyWindow, 0.5);
        this.hfPercentiles.p90 = this._percentile(this.hfEnergyWindow, 0.9);
      }
    }

    this.analyser.getFloatFrequencyData(this.frequencyData);
    if (this.isCalibrated && this.noiseSpectralProfile) {
      for (let i = 0; i < this.frequencyData.length; i++) {
        let signalMag = Math.pow(10, this.frequencyData[i] / 20);
        let noiseMag = this.noiseSpectralProfile[i] || 0;
        // Apply subtraction factor (over-subtraction = 1.5, floor = 0.01)
        let cleanMag = Math.max(0.01 * signalMag, signalMag - 1.5 * noiseMag);
        // Re-convert to dB scale for native compatibility with downstream dsp engines
        this.frequencyData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
      }
    }
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

    const aWeights = this._aWeightTableFor(fftBinHz, fData.length);
    const sumBandPowerAWeighted = (loHz, hiHz) => {
      if (hiHz <= loHz) return 0;
      const startBin = Math.max(0, Math.floor(loHz / fftBinHz));
      const endBin = Math.min(fData.length - 1, Math.ceil(hiHz / fftBinHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        const mag = Math.pow(10, fData[i] / 20);
        sum += mag * mag * aWeights[i];
      }
      return sum;
    };

    const eLowTilt = sumBandPowerAWeighted(lowStartHz, lowEndHz);
    const eHighTilt = sumBandPowerAWeighted(highStartHz, highEndHz);
    let rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
    // Guard against -Infinity/NaN when both bands are near-zero
    if (!isFinite(rawTiltDb)) rawTiltDb = this.spectralTiltSmoothedDb;
    
    // Subtract microphone color baseline learned during calibration
    rawTiltDb -= this.micTiltBaselineDb;
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
          console.log(`[ProsodyBall] Learned User Tilt Range: ${this.tiltProfile.min.toFixed(1)}dB to ${this.tiltProfile.max.toFixed(1)}dB`);
        }
      }
    }

    // Typical speech tilt spans roughly -34dB (heavy) to -4dB (light) on mobile mics.
    const heavyAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.min : -34;
    const lightAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.max : -4;
    const normalized = normalizeAgainstRange(this.spectralTiltSmoothedDb, heavyAnchorDb, lightAnchorDb);
    const tiltConfidenceGate = rms > this.noiseFloor * 1.35 ? 1 : Math.max(0, (rms - this.noiseFloor) / Math.max(1e-6, this.noiseFloor * 0.5 || 1e-6));
    this.spectralWeight += (normalized - this.spectralWeight) * (0.12 + tiltConfidenceGate * 0.2);
    this.spectralTiltConfidence += (tiltConfidenceGate - this.spectralTiltConfidence) * 0.2;

    // ====== H1–H2 (open quotient / breathiness cue for weight) ======
    // Amplitude of the 1st vs 2nd harmonic (dB). High H1-H2 = open/breathy/light; low or
    // negative = pressed/heavy. As a ratio of two nearby harmonics it is largely immune to
    // microphone colouration, complementing the (mic-sensitive) absolute spectral tilt.
    if (pitch > 0 && this.pitchConfidence > 0.4 && activeF0 > 0) {
      const hSearch = Math.max(1, Math.floor((activeF0 / fftBinHz) * 0.25));
      const harmonicPeakDb = (centerHz) => {
        const center = centerHz / fftBinHz;
        const lo = Math.max(1, Math.floor(center) - hSearch);
        const hi = Math.min(fData.length - 1, Math.ceil(center) + hSearch);
        let peak = -Infinity;
        for (let i = lo; i <= hi; i++) if (fData[i] > peak) peak = fData[i];
        return peak;
      };
      const h1 = harmonicPeakDb(activeF0);
      const h2 = harmonicPeakDb(activeF0 * 2);
      if (isFinite(h1) && isFinite(h2)) {
        this.h1h2SmoothedDb += ((h1 - h2) - this.h1h2SmoothedDb) * 0.16;
        this.h1h2Confidence += (clamp01(this.pitchConfidence) - this.h1h2Confidence) * 0.2;
      }
    } else {
      this.h1h2Confidence *= 0.9;
    }

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

    // --- Sibilant /s/ spectral centroid (gender cue that works on UNVOICED speech) ---
    // Only sample during clear fricative frames; otherwise let confidence decay so a silent
    // or voiced frame never injects a bogus centroid into the blend.
    if (fricativeRatio > 0.5 && hfEnergy > 0 && rms > this.noiseFloor * 1.3) {
      const hfBinHz = this.audioCtx.sampleRate / this.analyserHF.fftSize;
      // Lower bound raised to 4 kHz to exclude /ʃ/ (~2.5–3.5 kHz) so only /s/ frames
      // are measured. Upper bound 8500 Hz reaches the feminine /s/ ceiling without
      // requiring > 44.1 kHz sample rate (Nyquist must exceed 8.5 kHz).
      const rawCentroid = computeSpectralCentroid(this.hfFrequencyData, hfBinHz, 4000, 8500);
      if (rawCentroid > 0) {
        this.sibilantCentroidHz += (rawCentroid - this.sibilantCentroidHz) * 0.25;
        const target = Math.min(1, fricativeRatio);
        this.sibilantConfidence += (target - this.sibilantConfidence) * 0.25;
      }
    } else {
      this.sibilantConfidence *= 0.9;
    }

    // --- Stage 2: Resonance estimation (method-selectable) ---
    // Only run during confident voiced vowels
    if (pitch > 0 && this.pitchConfidence > 0.4 && this.vowelLikelihood > 0.25) {
      this.analyserFormant.getFloatFrequencyData(this.formantFreqData);
      if (this.isCalibrated && this.noiseSpectralProfile) {
        // Both analysers use fftSize=4096 so bins match exactly
        for (let i = 0; i < this.formantFreqData.length; i++) {
          let signalMag = Math.pow(10, this.formantFreqData[i] / 20);
          let noiseMag = this.noiseSpectralProfile[i] || 0;
          let cleanMag = Math.max(0.01 * signalMag, signalMag - 1.5 * noiseMag);
          this.formantFreqData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
        }
      }

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

      // --- Kalman-Filtered Formant Continuity ---
      // Replaces simple EMA/jump-penalty with a 1D constant-velocity model.
      // During pitch slides, velocity tracks the true formant trajectory
      // and rejects harmonic-locked outliers.
      
      const methodTrustMap = {
        lpc: 1.0,      // precise root-solved values -> low measurement noise
        harmonic: 0.7, // good but harmonic-resolution limited
        cepstral: 0.5, // smooth but broad
        centroid: 0.3  // conflates pitch
      };
      const methodTrust = methodTrustMap[this.resonanceMethod] || methodTrustMap.harmonic;
      
      // Adaptive measurement noise: low confidence = large R (trust prediction more)
      const R_base = 2500; // Hz^2 base measurement noise
      const R_scale = Math.max(0.1, conf * methodTrust);
      const R = R_base / (R_scale * R_scale);

      if (f1Candidate > 0) this.smoothF1 = this._kalmanUpdate(this._kalmanF1, f1Candidate, R);
      if (f2Candidate > 0) this.smoothF2 = this._kalmanUpdate(this._kalmanF2, f2Candidate, R);
      if (f3Candidate > 0) this.smoothF3 = this._kalmanUpdate(this._kalmanF3, f3Candidate, R);
      this.formantConfidence += (conf - this.formantConfidence) * 0.15;

      // --- Resonance score: aVTL-primary (vowel-robust), with F1 and gated F2 ---
      // Primary: apparent vocal-tract length from formant dispersion (ΔF). Vowel-robust because
      // ΔF is the mean adjacent formant spacing across F1–F3, which is much less vowel-dependent
      // than raw F2 alone.  Anchors: 17 cm (male, score 0) → 14 cm (female, score 1).
      const aVTL_cm = this.formantDispersionHz > 0 ? 35000 / (2 * this.formantDispersionHz) : 0;
      const vtlScore = aVTL_cm > 0 ? clamp01((17 - aVTL_cm) / 3) : 0;
      // F1 (25%): high F1 is decisive for "not male" (open, forward resonance).
      const f1Score = Math.max(0, Math.min(1, (this.smoothF1 - 300) / 600));
      // Vowel-normalized F2 (20%): only used when a vowel-like frame is detected; otherwise
      // fold into vtlScore to avoid penalising back vowels (/u/ F2 ≈ 1000 Hz).
      const f2Score = this.vowelLikelihood > 0.4
        ? clamp01((this.smoothF2 - 1000) / 1400)
        : vtlScore;
      const rawResonance = vtlScore * 0.55 + f1Score * 0.25 + f2Score * 0.20;
      this.smoothResonance += (rawResonance - this.smoothResonance) * (0.05 + conf * 0.08);

      // --- Formant dispersion (ΔF) -> apparent vocal-tract length gender cue ---
      const rawDispersion = computeFormantDispersion([this.smoothF1, this.smoothF2, this.smoothF3]);
      if (rawDispersion > 0) {
        this.formantDispersionHz += (rawDispersion - this.formantDispersionHz) * (0.05 + conf * 0.08);
      }

      // --- Cepstral Peak Prominence (breathiness) — every Nth frame for cost control ---
      this._cppFrameCounter = (this._cppFrameCounter + 1) % 6;
      if (this._cppFrameCounter === 0 && pitch > 0) {
        // Decimate the log spectrum by 2 to halve the DCT cost. The quefrency of F0
        // (q0 = sampleRate/F0) is invariant to spectral resolution, so this is safe down
        // to ~55 Hz as long as the cepstrum is long enough to hold q0.
        const src = this.frequencyData;
        const half = src.length >> 1;
        if (!this._cppSpectrum || this._cppSpectrum.length !== half) {
          this._cppSpectrum = new Float64Array(half);
        }
        const dec = this._cppSpectrum;
        for (let i = 0; i < half; i++) dec[i] = (src[2 * i] + src[2 * i + 1]) * 0.5;
        const q0 = this.audioCtx.sampleRate / pitch; // quefrency (lag in samples) of F0
        const maxQ = Math.min(half - 1, Math.ceil(this.audioCtx.sampleRate / 55));
        const cepstrum = computeCepstrum(dec, maxQ);
        const rawCpp = computeCPP(cepstrum, q0);
        if (rawCpp > 0) {
          this.cppDb += (rawCpp - this.cppDb) * 0.2;
          this.cppConfidence += (Math.min(1, this.pitchConfidence) - this.cppConfidence) * 0.2;
        }
      }
    } else {
      this.cppConfidence *= 0.9;
      // During silence/unvoiced: decay confidence, coast Kalman filters on prediction
      this.formantConfidence *= 0.95;
      if (this._kalmanF1 && this._kalmanF1.initialized) {
        this.smoothF1 = this._kalmanUpdate(this._kalmanF1, this.smoothF1, 1e6); // large R = ignore measurement
      }
      if (this._kalmanF2 && this._kalmanF2.initialized) {
        this.smoothF2 = this._kalmanUpdate(this._kalmanF2, this.smoothF2, 1e6);
      }
      if (this._kalmanF3 && this._kalmanF3.initialized) {
        this.smoothF3 = this._kalmanUpdate(this._kalmanF3, this.smoothF3, 1e6);
      }
    }

    // ====== METRICS ======

    // 1. BOUNCE — pitch variation in semitones relative to modal F0.
    // Using semitones instead of Hz means the score is invariant to the user's absolute pitch:
    // the same expressive range sounds the same whether produced by a bass or a soprano.
    if (this.pitchHistory.length > 3 && this.modalF0Hz > 0) {
      const fRef = this.modalF0Hz;
      const len = this.pitchHistory.length;
      let stSum = 0;
      for (let i = 0; i < len; i++) stSum += 12 * Math.log2(this.pitchHistory[i] / fRef);
      const stMean = stSum / len;
      let stSqSum = 0;
      for (let i = 0; i < len; i++) {
        const d = 12 * Math.log2(this.pitchHistory[i] / fRef) - stMean;
        stSqSum += d * d;
      }
      this.metrics.bounce = clamp01(Math.sqrt(stSqSum / len) / INTONATION_ST_DIVISOR);
    } else {
      this.metrics.bounce *= 0.95;
    }

    // Pre-calculate robust baseline for dynamic thresholding across metrics
    const baseEnergyRange = Math.max(0.001, this.energyPercentiles.p90 - this.energyPercentiles.p50);



    // 3. VOWEL ELONGATION — sustained voicing WITH vowel-like formants
    //    Uses vowelLikelihood to distinguish real vowels from "sss" or "mmm".
    //    Mode detection: track recent voiced-segment lengths. If the median is long (>0.5 s)
    //    we're in diagnostic/sustain mode; short segments → connected speech mode with
    //    faster onset/saturation so natural conversational pacing can reach 1.0.
    const dynamicSustainThreshold = this.energyPercentiles.p50 + baseEnergyRange * VOWEL_SUSTAIN_MULT;
    const isVoiced = pitch > 0 && gatedRms > dynamicSustainThreshold;
    // Update phonation duration ring buffer when a voiced segment ends.
    if (isVoiced && this._currentPhonationStart < 0) {
      this._currentPhonationStart = now;
    } else if (!isVoiced && this._currentPhonationStart >= 0) {
      const segDur = now - this._currentPhonationStart;
      this._phonationDurations.push(segDur);
      if (this._phonationDurations.length > this._phonationDurMax) this._phonationDurations.shift();
      this._currentPhonationStart = -1;
    }
    // Choose timing constants based on typical phonation length.
    let vowelOnset = VOWEL_ONSET_SECS;
    let vowelSat = VOWEL_SATURATION_SECS;
    let vowelDecay = VOWEL_DECAY_RATE;
    if (this._phonationDurations.length >= 4) {
      const sorted = [...this._phonationDurations].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median < 0.5) {
        vowelOnset = VOWEL_CONNECTED_ONSET_SECS;
        vowelSat = VOWEL_CONNECTED_SATURATION_SECS;
        vowelDecay = VOWEL_CONNECTED_DECAY_RATE;
      }
    }
    const isVowelSound = isVoiced && this.vowelLikelihood > 0.3;
    if (isVowelSound) {
      this.sustainedDuration += dt * (0.5 + this.vowelLikelihood * 0.5); // stronger vowels accumulate faster
    } else {
      this.sustainedDuration *= vowelDecay;
    }
    this.metrics.vowel = Math.min(1, Math.max(0, this.sustainedDuration - vowelOnset) / vowelSat);

    // 4. ARTICULATION — HF bursts (adaptive ceiling from running HF percentiles)
    const hfCeiling = this.hfEnergyWindow.length >= 8
      ? Math.max(this.hfPercentiles.p90, this.hfNoiseFloor + 0.02)
      : Math.max(this.hfNoiseFloor + 0.02, this.hfNoiseFloor * 3.5);
    const articTarget = normalizeAgainstPercentiles(hfEnergy, this.hfNoiseFloor, hfCeiling, ARTIC_SENSITIVITY_GAIN);
    this.metrics.articulation += (articTarget - this.metrics.articulation) * 0.3;

    // Energy rise rate (per second) — feeds the Vocal Attack onset-hardness metric.
    const riseRate = Math.max(0, gatedRms - this.prevGatedRms) / Math.max(1e-3, dt);
    this.prevGatedRms = gatedRms;

    // 5. SYLLABLE SEPARATION — energy onset detection (uses gated energy)
    const dynamicSyllableOn = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_ON_MULT;
    const dynamicSyllableOff = this.energyPercentiles.p50 + baseEnergyRange * SYLLABLE_OFF_MULT;
    const syllableOnThreshold = Math.max(0.005, dynamicSyllableOn);
    const syllableOffThreshold = Math.max(0.002, dynamicSyllableOff);
    if (gatedRms > syllableOnThreshold && this.syllableState === 'silent') {
      if (now - this.lastSyllableTime > SYLLABLE_DEBOUNCE_SECS) {
        this.lastSyllableTime = now;
        this.syllableImpulse = 1.0;
        // Open the vocal-attack capture window at this phonation onset.
        this.attackWindowTimer = 0;
        this.attackRisePeak = riseRate;
        this.attackPeakTime = 0;
      }
      this.syllableState = 'voiced';
    } else if (gatedRms < syllableOffThreshold) {
      this.syllableState = 'silent';
    }
    this.syllableImpulse *= SYLLABLE_IMPULSE_DECAY;

    // 6. VOCAL ATTACK — onset hardness from the peak energy-rise rate at phonation
    //    onset. Steep rise = hard/glottal (→1); gradual rise = soft/breathy (→0).
    if (this.attackWindowTimer >= 0) {
      this.attackWindowTimer += dt;
      if (riseRate > this.attackRisePeak) {
        this.attackRisePeak = riseRate;
        this.attackPeakTime = this.attackWindowTimer;
      }
      if (this.attackWindowTimer >= ATTACK_RISE_WINDOW_SECS) {
        // Train the ceiling only on reliably-voiced onsets, so coughs, mic bumps, or
        // unvoiced bursts can't ratchet it up and de-sensitize real phonation onsets.
        if (this.pitchConfidence > 0.35 || this.formantConfidence > 0.35) {
          const k = this.attackRisePeak > this.attackRiseCeiling ? 0.30 : ATTACK_RISE_LEARN_RATE;
          this.attackRiseCeiling += (this.attackRisePeak - this.attackRiseCeiling) * k;
        }
        // Breathiness refinement: breathy onsets (poor pitch lock, HF-noisy) read softer.
        const cleanliness = clamp01(this.pitchConfidence) *
                            (1 - 0.5 * clamp01(this.metrics.articulation));
        // Onset abruptness: impulsive onsets peak at the very start of the capture window
        // (→1), gradual/breathy onsets peak later within it (→0).
        const onsetAbruptness = 1 - clamp01(this.attackPeakTime / ATTACK_RISE_WINDOW_SECS);
        const hardness = computeAttackHardness({
          risePeak: this.attackRisePeak,
          riseCeiling: this.attackRiseCeiling,
          cleanliness,
          onsetAbruptness,
          abruptWeight: ATTACK_ABRUPT_BLEND
        });
        this.attackImpulse = Math.max(this.attackImpulse, hardness);
        // Latch the two sub-cues for the Attack-mode display (does NOT affect metrics.attack):
        // rise-rate hardness (steepness of the energy onset) vs onset abruptness (timing).
        this.attackRiseHardness = clamp01(this.attackRisePeak / Math.max(1e-6, this.attackRiseCeiling));
        this.attackAbruptness = onsetAbruptness;
        this.attackWindowTimer = -1; // close window
      }
    }
    this.attackImpulse *= ATTACK_IMPULSE_DECAY;
    this.metrics.attack = this.attackImpulse;

    const voicedStrength = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1);
    const pitchGate = pitch > 0 ? 1 : 0.35;
    const { confidenceGate, voicedGate, reliableFrame } = computeFrameReliability({
      pitchConfidence: this.pitchConfidence,
      formantConfidence: this.formantConfidence,
      voicedStrength,
      spectralTiltConfidence: this.spectralTiltConfidence,
      wasLastFrameReliable: this.wasLastFrameReliable
    });
    this.wasLastFrameReliable = reliableFrame;

    // Stricter confidence gating
    if (!reliableFrame && gatedRms < this.energyPercentiles.p75) {
      // Freeze/slow-decay updates when signal is muddy or user is breathing
      this.metrics.bounce *= 0.95;
    } else {
      this.metrics.bounce *= confidenceGate * pitchGate;
    }

    this.metrics.articulation *= Math.max(0.25, voicedGate * 0.8 + confidenceGate * 0.2);
    this.metrics.attack *= Math.max(0.2, voicedGate);

    const pitchRange = Math.max(50, this.pitchProfile.max - this.pitchProfile.min);
    // pitchEffort: position within the user's own adaptive range — hygiene/practice feedback only.
    this.metrics.pitchEffort = pitch > 0 ? Math.max(0, Math.min(1, (pitch - this.pitchProfile.min) / pitchRange)) : this.metrics.pitchEffort * 0.95;
    // Legacy alias so existing UI reads of metrics.pitch still work.
    this.metrics.pitch = this.metrics.pitchEffort;
    // pitchZone: absolute position across the perceptual gender boundary (110 Hz → 230 Hz).
    // 0 = reliably masculine, 1 = reliably feminine, independent of the user's own range.
    if (this.modalF0Hz > 0) {
      this.metrics.pitchZone = clamp01((this.modalF0Hz - 110) / 120);
      const hz = this.modalF0Hz;
      this.pitchZoneLabel = hz < 145 ? 'Masculine'
        : hz < 175 ? 'Ambiguous'
        : hz < 180 ? 'Transitional'
        : 'Feminine';
    }
    this.metrics.energy = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1.1);
    this.metrics.resonance = this.smoothResonance;

    // 7. WEIGHT — perceived heaviness (1=heavy/thick, 0=light/breathy). Source-only cues only;
    //    F2 (a filter/resonance property) has been removed to avoid cross-contamination.
    //    Tilt 45% + CPP 30% + H1-H2 25%.
    const heavinessTilt = 1 - this.spectralWeight;
    // CPP: higher CPP = more periodic/pressed (heavier); lower = breathier (lighter).
    // Anchors: 6 dB (breathy/light) → 14 dB (modal-pressed/heavy).
    const cppHeaviness = clamp01((this.cppDb - 6) / 8);
    const cppW = WEIGHT_CPP_BLEND * this.cppConfidence;
    // H1-H2 breathiness cue → lightness; only blended in when a clean F0 gives a trustworthy estimate.
    const h1h2Light = normalizeAgainstRange(this.h1h2SmoothedDb, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    const weightTarget = computeWeightTarget({
      tiltHeaviness: heavinessTilt,
      tiltWeight: WEIGHT_TILT_BASE,
      h1h2Heaviness: 1 - h1h2Light,
      h1h2Weight: WEIGHT_H1H2_BLEND * this.h1h2Confidence,
      cppHeaviness,
      cppWeight: cppW,
    });
    // Only move while tilt is trustworthy, so the metric holds its last value rather
    // than drifting toward "light" during silence or noisy low-confidence frames.
    if (this.spectralTiltConfidence > 0.2) {
      this.weightSmoothed += (weightTarget - this.weightSmoothed) * (WEIGHT_SMOOTH_BASE + this.spectralTiltConfidence * 0.18);
    }
    this.metrics.weight = this.weightSmoothed;

    // Expose overall frame confidence so the game loop can gate the prosody score
    this.frameConfidence = reliableFrame ? confidenceGate : 0.15;
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
    const minF2Hz = 600, maxF2Hz = 3500;
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
    let specMin = 0, specRange = 0;
    if (specSlice.length > 0) {
      specMin = specSlice[0]; let specMax = specSlice[0];
      for (let i = 1; i < specSlice.length; i++) {
        if (specSlice[i] < specMin) specMin = specSlice[i];
        if (specSlice[i] > specMax) specMax = specSlice[i];
      }
      specRange = specMax - specMin;
    }
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
    const { rootsRe, rootsIm } = this._findLPCRoots(a, order);

    // Extract formants from roots: each complex conjugate pair with positive
    // imaginary part gives a formant frequency and bandwidth
    const formants = [];
    for (let i = 0; i < order; i++) {
      const re = rootsRe[i];
      const im = rootsIm[i];
      if (im <= 0) continue;
      const freq = Math.atan2(im, re) * dsRate / (2 * Math.PI);
      const mag = Math.sqrt(re * re + im * im);
      const bw = -dsRate * Math.log(Math.max(mag, 1e-12)) / Math.PI;
      if (freq >= 90 && freq <= 5000 && bw > 30 && bw < 600) {
        formants.push({ freq, bw });
      }
    }

    formants.sort((lhs, rhs) => lhs.freq - rhs.freq);

    let f1 = 0; let f2 = 0; let f3 = 0;
    let f1Bw = 999; let f2Bw = 999;
    const minSep = 200;
    for (const fm of formants) {
      if (f1 === 0 && fm.freq >= 150 && fm.freq <= 1200) {
        f1 = fm.freq; f1Bw = fm.bw;
      } else if (f2 === 0 && fm.freq >= 600 && fm.freq <= 3500 && fm.freq > f1 + minSep) {
        f2 = fm.freq; f2Bw = fm.bw;
      } else if (f3 === 0 && fm.freq >= 2000 && fm.freq <= 4500 && fm.freq > f2 + minSep) {
        f3 = fm.freq;
      }
    }

    const nFound = (f1 > 0 ? 1 : 0) + (f2 > 0 ? 1 : 0) + (f3 > 0 ? 1 : 0);
    let bwScore = 0;
    if (f1 > 0) bwScore += Math.max(0, 1 - f1Bw / 400);
    if (f2 > 0) bwScore += Math.max(0, 1 - f2Bw / 400);
    bwScore = nFound > 0 ? bwScore / Math.min(2, nFound) : 0;
    const conf = Math.min(1, (nFound / 3) * bwScore * this.pitchConfidence * (this.vowelLikelihood + 0.3) * 2.5);

    if (f1 === 0) f1 = 500;
    if (f2 === 0) f2 = 1500;

    return { f1, f2, f3, confidence: conf };
  }

  // Durand-Kerner root finding for LPC polynomial
  // Finds all roots of z^n - a[1]z^(n-1) - a[2]z^(n-2) - ... - a[n] = 0
  _findLPCRoots(a, order) {
    const rootsRe = this._getBuffer('lpcRootsRe', Float64Array, order);
    const rootsIm = this._getBuffer('lpcRootsIm', Float64Array, order);

    for (let k = 0; k < order; k++) {
      const angle = 2 * Math.PI * (k + 0.5) / order;
      const radius = 0.9 + 0.05 * Math.random();
      rootsRe[k] = radius * Math.cos(angle);
      rootsIm[k] = radius * Math.sin(angle);
    }

    for (let iter = 0; iter < 50; iter++) {
      let maxDelta = 0;
      for (let k = 0; k < order; k++) {
        const zRe = rootsRe[k];
        const zIm = rootsIm[k];

        let pRe = 1;
        let pIm = 0;
        for (let j = 1; j <= order; j++) {
          const nextRe = pRe * zRe - pIm * zIm;
          const nextIm = pRe * zIm + pIm * zRe;
          pRe = nextRe - a[j];
          pIm = nextIm;
        }

        let prodRe = 1;
        let prodIm = 0;
        for (let j = 0; j < order; j++) {
          if (j === k) continue;
          const dRe = zRe - rootsRe[j];
          const dIm = zIm - rootsIm[j];
          const nextProdRe = prodRe * dRe - prodIm * dIm;
          const nextProdIm = prodRe * dIm + prodIm * dRe;
          prodRe = nextProdRe;
          prodIm = nextProdIm;
        }

        const denom = prodRe * prodRe + prodIm * prodIm + 1e-30;
        const deltaRe = (pRe * prodRe + pIm * prodIm) / denom;
        const deltaIm = (pIm * prodRe - pRe * prodIm) / denom;
        rootsRe[k] = zRe - deltaRe;
        rootsIm[k] = zIm - deltaIm;
        maxDelta = Math.max(maxDelta, Math.hypot(deltaRe, deltaIm));
      }
      if (maxDelta < 1e-8) break;
    }

    return { rootsRe, rootsIm };
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
    const minF2Hz = 600, maxF2Hz = 3500;
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

    let envMin = 0, envRange = 0;
    if (env.length > 0) {
      envMin = env[0]; let envMax = env[0];
      for (let i = 1; i < env.length; i++) {
        if (env[i] < envMin) envMin = env[i];
        if (env[i] > envMax) envMax = env[i];
      }
      envRange = envMax - envMin;
    }
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
