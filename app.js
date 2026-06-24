import { computeProsodyScore, computeRawProsody, pitchHzToPosition, getMicDiagnostics, ensureAudioContextRunning, clamp01, computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange, computeWeightTarget, computeAttackHardness, computeGenderScore, genderScoreToHue, computeSpectralCentroid, computeFormantDispersion, computeCepstrum, computeCPP, computeGenderScoreMulti, computeModalF0Femininity, computeSibilantFemininity, dispersionToFemininity, cppToFemininity, correctOctaveError, aPosterioriSnrDb, snrToConfidence, snrTier, adaptiveOverSubtraction, NOISE_PROFILE_UPDATE_RATE, steadyStateWeight, selectResonanceMethod, FEMINIZATION_CUE_WEIGHTS, MASCULINIZATION_CUE_WEIGHTS } from './dsp-utils.js';
import { SNR_VOICE_BAND_LO_HZ, SNR_VOICE_BAND_HI_HZ, YIN_THRESHOLD, PITCH_CONFIDENCE_FACTOR } from './dsp-constants.generated.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { CalibrationWizard } from './calibration-wizard.js';
import { BulbController } from './bulb-controller.js';
import { NecklaceController, HapticSrc } from './necklace-controller.js';

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
// DSP TUNING CONSTANTS
// Centralised so they're easy to find, tweak, and document.
// ============================================================
// YIN_THRESHOLD and PITCH_CONFIDENCE_FACTOR now come from dsp-constants.generated.js
// (single source of truth: dsp-constants.json) — imported above, not defined here.
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
const H1H2_HEAVY_DB = -2;                // H1-H2 (dB) anchor for pressed/heavy phonation
const H1H2_LIGHT_DB = 14;                // H1-H2 (dB) anchor for breathy/light phonation
const WEIGHT_SMOOTH_BASE = 0.10;         // Base EMA rate toward the weight target
const ATTACK_RISE_WINDOW_SECS = 0.06;    // Capture peak energy-rise within 60ms of an onset
const ATTACK_IMPULSE_DECAY = 0.90;       // Per-frame decay of the vocal-attack impulse
const ATTACK_RISE_LEARN_RATE = 0.02;     // EMA rate for the adaptive rise-rate ceiling
const ATTACK_ABRUPT_BLEND = 0.30;        // Blend weight for onset-abruptness vs amplitude-rise hardness
const MAX_SPARKLES = 100;                // Maximum sparkle particles in ball mode

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
    // 'auto' picks an estimator per-frame from the smoothed SNR (see selectResonanceMethod);
    // the rest force one estimator. 'auto' is the default so the live number leans on whichever
    // method degrades least in the current noise instead of one static choice.
    this.resonanceMethod = 'auto'; // 'auto' | 'harmonic' | 'cepstral' | 'lpc' | 'centroid'
    this.activeResonanceMethod = 'harmonic'; // estimator actually used this frame (resolves 'auto')
    this.smoothResonance = 0.5; // 0=low/dark resonance, 1=high/bright resonance
    this.smoothF1 = 500;        // smoothed F1 estimate (Hz)
    this.smoothF2 = 1500;       // smoothed F2 estimate (Hz) — primary resonance correlate
    this.smoothF3 = 2700;       // smoothed F3 estimate (Hz) — secondary resonance cue
    this.formantConfidence = 0;  // how reliable current F1/F2/F3 estimates are
    this.vowelLikelihood = 0;   // 0=not vowel-like, 1=strong vowel formants
    // Steady-state targeting: weight live frames by how "held" they are so vowel targets
    // dominate the estimate over onset/offset/coarticulation frames (see steadyStateWeight).
    this.formantSteadiness = 1;  // smoothed steady-state weight [floor..1] for the live score
    this._prevResF1 = 0;         // last accepted raw F1 candidate (for frame-to-frame delta)
    this._prevResF2 = 0;         // last accepted raw F2 candidate

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

    // Per-frame SNR / noise-trust (Layer A feature packet; see docs/DSP_CONTRACT.md).
    // Start optimistic (assume a quiet room) so the UI doesn't flash red before the
    // first measurement lands.
    this.snrDb = 20;            // raw a-posteriori SNR over the voice band this frame
    this.snrDbSmoothed = 20;    // EMA used for the over-subtraction factor + tiering
    this.snrConfidence = 1;     // 0..1 trust derived from SNR; folds into the gate
    this.snrTier = 'green';     // 'green' | 'yellow' | 'red' for UI/haptics
    this.overSubFactor = 1.5;   // SNR-adaptive spectral over-subtraction (was hardcoded 1.5)

    this.metrics = {
      bounce: 0, vowel: 0,
      articulation: 0,
      pitch: 0, pitchEffort: 0, pitchZone: 0.5,
      energy: 0, resonance: 0,
      attack: 0, weight: 0,
      // Noise-trust surfaced to renderers/haptics (read-only, see docs/DSP_CONTRACT.md)
      snrDb: 20, snrTier: 'green', snrConfidence: 1,
      // Resonance diagnostics: steady-state weight applied this frame + active estimator
      // (resolves 'auto'). Read-only; surfaced for the eval harness / UI debugging.
      resSteadiness: 1, resMethod: 'harmonic'
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
    this.formantSteadiness = 1;
    this._prevResF1 = 0;
    this._prevResF2 = 0;
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
    // --- Spectral subtraction + per-frame voice-band SNR ---
    // Over-subtraction adapts to the *previous* frame's smoothed SNR (SNR moves slowly
    // relative to the frame rate, so this frame's factor is known before the loop). On
    // detected pause frames we also EMA the per-bin noise profile toward the current
    // spectrum, so a changing room (HVAC cycling, car RPM) re-tracks instead of
    // mis-subtracting a profile frozen at calibration time.
    this.overSubFactor = adaptiveOverSubtraction(this.snrDbSmoothed);
    const snrBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const SNR_LO_HZ = SNR_VOICE_BAND_LO_HZ, SNR_HI_HZ = SNR_VOICE_BAND_HI_HZ; // voice band (from spec); excludes <300 Hz rumble
    const profileRate = rms < this.noiseFloor * 1.5 ? NOISE_PROFILE_UPDATE_RATE : 0; // pause → update
    if (this.isCalibrated && this.noiseSpectralProfile) {
      let snrSigPow = 0, snrNoisePow = 0;
      for (let i = 0; i < this.frequencyData.length; i++) {
        let signalMag = Math.pow(10, this.frequencyData[i] / 20);
        if (profileRate > 0) {
          // A pause frame is a fresh ambient sample: nudge the per-bin profile toward it.
          this.noiseSpectralProfile[i] += (signalMag - this.noiseSpectralProfile[i]) * profileRate;
        }
        let noiseMag = this.noiseSpectralProfile[i] || 0;
        const fHz = i * snrBinHz;
        if (fHz >= SNR_LO_HZ && fHz <= SNR_HI_HZ) {
          snrSigPow += signalMag * signalMag;
          snrNoisePow += noiseMag * noiseMag;
        }
        // SNR-adaptive over-subtraction (floor 0.01) — replaces the old constant 1.5.
        let cleanMag = Math.max(0.01 * signalMag, signalMag - this.overSubFactor * noiseMag);
        // Re-convert to dB scale for native compatibility with downstream dsp engines
        this.frequencyData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
      }
      this.snrDb = aPosterioriSnrDb(snrSigPow, snrNoisePow);
    } else {
      // Pre-calibration / calibration-skipped fallback: broadband amplitude ratio
      // (rms is amplitude, hence 20·log10) against the scalar noise floor.
      this.snrDb = 20 * Math.log10(Math.max(rms, 1e-6) / Math.max(this.noiseFloor, 1e-6));
    }
    this.snrDbSmoothed += (this.snrDb - this.snrDbSmoothed) * 0.2;
    this.snrConfidence = snrToConfidence(this.snrDbSmoothed);
    this.snrTier = snrTier(this.snrDbSmoothed);
    this.metrics.snrDb = this.snrDbSmoothed;
    this.metrics.snrConfidence = this.snrConfidence;
    this.metrics.snrTier = this.snrTier;
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
        // Both analysers use fftSize=4096 so bins match exactly. Reuse this frame's
        // SNR-adaptive over-subtraction factor (set in the main spectrum pass above).
        for (let i = 0; i < this.formantFreqData.length; i++) {
          let signalMag = Math.pow(10, this.formantFreqData[i] / 20);
          let noiseMag = this.noiseSpectralProfile[i] || 0;
          let cleanMag = Math.max(0.01 * signalMag, signalMag - this.overSubFactor * noiseMag);
          this.formantFreqData[i] = cleanMag > 1e-10 ? 20 * Math.log10(cleanMag) : -200;
        }
      }

      let f1Candidate = 0, f2Candidate = 0, f3Candidate = 0, conf = 0;

      // In 'auto', resolve the estimator from the (slow-moving) smoothed SNR so the live
      // number leans on whichever method degrades least in the current noise; otherwise honour
      // the explicit selection. activeResonanceMethod feeds methodTrust + the UI/metrics.
      const effectiveMethod = this.resonanceMethod === 'auto'
        ? selectResonanceMethod(this.snrDbSmoothed)
        : this.resonanceMethod;
      this.activeResonanceMethod = effectiveMethod;

      switch (effectiveMethod) {
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

      // --- Steady-state weighting (vowel-target targeting) ---
      // Reuse existing primitives — recent pitch trajectory + this method's raw F1/F2 — to
      // gauge how "held" this frame is. Onset/offset/glide frames score low; held vowels score
      // high. The weight modulates how hard a frame may move the live estimate (below), so the
      // resonance number leans on clinician-measurable steady frames without any separate mode.
      let pitchDevSt = 0;
      const ph = this.pitchHistory;
      if (ph.length >= 3) {
        const n = Math.min(5, ph.length); // short window → local glide, not long-window prosody
        let sum = 0;
        for (let i = ph.length - n; i < ph.length; i++) sum += ph[i];
        const mean = sum / n;
        if (mean > 0) {
          let sq = 0;
          for (let i = ph.length - n; i < ph.length; i++) {
            const st = 12 * Math.log2(ph[i] / mean);
            sq += st * st;
          }
          pitchDevSt = Math.sqrt(sq / n);
        }
      }
      let formantRelDelta = 0;
      if (this._prevResF1 > 0 && this._prevResF2 > 0 && f1Candidate > 0 && f2Candidate > 0) {
        formantRelDelta = Math.abs(f1Candidate - this._prevResF1) / this._prevResF1
                        + Math.abs(f2Candidate - this._prevResF2) / this._prevResF2;
      }
      if (f1Candidate > 0) this._prevResF1 = f1Candidate;
      if (f2Candidate > 0) this._prevResF2 = f2Candidate;
      const steadiness = steadyStateWeight({ pitchSemitoneDev: pitchDevSt, formantRelDelta });
      this.formantSteadiness += (steadiness - this.formantSteadiness) * 0.3;
      this.metrics.resSteadiness = this.formantSteadiness;
      this.metrics.resMethod = effectiveMethod;

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
      const methodTrust = methodTrustMap[effectiveMethod] || methodTrustMap.harmonic;

      // Adaptive measurement noise: low confidence = large R (trust prediction more).
      // Steady-state weight folds in here too so jumpy transition frames inflate R (and are
      // pulled toward the prediction) while held-vowel frames are trusted at face value.
      const R_base = 2500; // Hz^2 base measurement noise
      const R_scale = Math.max(0.1, conf * methodTrust * this.formantSteadiness);
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
      // Steady-state weight scales the EMA step: held vowels move the score quickly toward
      // their reading; transition frames only nudge it (floor), so the live number settles on
      // vowel targets rather than chasing onsets/glides.
      this.smoothResonance += (rawResonance - this.smoothResonance) * (0.05 + conf * 0.08) * this.formantSteadiness;

      // --- Formant dispersion (ΔF) -> apparent vocal-tract length gender cue ---
      const rawDispersion = computeFormantDispersion([this.smoothF1, this.smoothF2, this.smoothF3]);
      if (rawDispersion > 0) {
        this.formantDispersionHz += (rawDispersion - this.formantDispersionHz) * (0.05 + conf * 0.08) * this.formantSteadiness;
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
      snrConfidence: this.snrConfidence,
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
    this._isStarting = false; // guard for startGame/stopGame race
    this.lastTime = 0;
    this.idleAnimId = null;
    this._disposables = []; // cleanup callbacks for listeners/observers
    this._pendingTimeouts = []; // track setTimeout IDs for cleanup

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
    this.userZoomMultiplier = 1; // manual zoom in/out, applied on top of the dynamic zoom
    this.prosodyScore = 0;  // smoothed composite prosody signal (0=monotone, 1=expressive)
    this.particles = [];
    this.trailPoints = [];
    this.sparkles = [];
    this.themeMode = 'highcontrast';
    this.colorblindMode = false;
    // Orb color mode: 'pitch' (hue from F0) or 'gender' (hue from perceived vocal gender).
    this.colorMode = localStorage.getItem('vox:colorMode') || 'pitch';
    this.dafEnabled = localStorage.getItem('vox:daf:enabled') === 'true';
    this.dafDelayMs = parseInt(localStorage.getItem('vox:daf:delayMs') || '75');
    // Default OFF so DAF plays back the full raw voice band instead of cutting bass.
    this.dafBassFilter = localStorage.getItem('vox:daf:bassFilter') === 'true';
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    this._dafInterval = null;
    this._dafGain = null;
    this._dafFilter = null;
    this.smoothGenderScore = 0.5; // EMA of the 0..1 perceived-gender score (0.5 = androgynous)
    this.genderUncertainty = 1;   // 0..1 spread/disagreement of the gender cues
    // Per-cue toggles for the perceived-gender model. pitch + resonance are always on (the
    // original baseline); these are user-toggleable. Intonation is a sociolinguistic stereotype
    // (not anatomy) so it defaults OFF.
    const cueOn = (key, dflt) => {
      const v = localStorage.getItem(key);
      return v == null ? dflt : v === 'true';
    };
    this.genderCues = {
      // pitchZone, resonance always on; weight defaults on (source-only, reliable).
      weight: cueOn('vox:genderCue:weight', true),
      sibilant: cueOn('vox:genderCue:sibilant', true),
      intonation: cueOn('vox:genderCue:intonation', false),
      // Legacy keys preserved so stored user prefs are not silently lost.
      modalF0: cueOn('vox:genderCue:modalF0', true),
      dispersion: cueOn('vox:genderCue:dispersion', true),
      cpp: cueOn('vox:genderCue:cpp', true),
    };
    // Goal direction: 'feminization' | 'masculinization'. Determines cue weights and
    // incongruence-guard direction. Defaults to feminization.
    const storedGoal = localStorage.getItem('vox:goalMode');
    this.goalMode = storedGoal === 'masculinization' ? 'masculinization' : 'feminization';
    this.gameMode = 'ball';

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
      scrollAtStart: 0,
    };

    // ====== ACCESSIBILITY ======
    this.userMotionPreference = localStorage.getItem('vox:motionPreference') || 'auto';
    this.micInputPreferences = {
      deviceId: localStorage.getItem('vox:micDeviceId') || 'default',
      // Default OFF: phones route echo cancellation / noise suppression / AGC through a
      // telephony-style voice processing pipeline that band-limits the signal (cutting
      // both low and high frequencies), which is what makes captured/played-back voice
      // sound duller and "deeper" than the raw mic input.
      echoCancellation: localStorage.getItem('vox:echoCancellation') === 'true',
      noiseSuppression: localStorage.getItem('vox:noiseSuppression') === 'true',
      autoGainControl: localStorage.getItem('vox:autoGainControl') === 'true',
    };
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.baseParticleScale = 1;
    this.particleScale = 1;
    this.dynamicQualityScale = 1;
    this._applyMotionPreferences();
    const motionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = (e) => {
      this.reducedMotion = e.matches;
      this._applyMotionPreferences();
    };
    motionMql.addEventListener('change', onMotionChange);
    this._disposables.push(() => motionMql.removeEventListener('change', onMotionChange));

    // ====== RUNTIME TOOLS ======
    this.perfMonitor = new PerformanceMonitor({ panelId: 'perfPanel' });
    this.calibrationWizard = new CalibrationWizard();
    this.bulbController = new BulbController({ swatchId: 'bulbSimSwatch', statusId: 'bulbStatus' });
    this.necklaceController = new NecklaceController({ onStatus: (s) => this._onNecklaceStatus(s) });
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
    // Reliability presentation (Layer B; see docs/DSP_CONTRACT.md): a render-side EMA of
    // the analyzer's snrConfidence drives ball vividness so the user can tell whether
    // they're changing their voice or just their room. Starts trusted so nothing flashes.
    this.trustVividness = 1;
    this._lowTrustSecs = 0; // sustained red-tier time; gates the calm text nudge
    this.pitchGridStrength = 'strong';
    this.teleprompterMode = 'off';
    this.voiceProfilePreset = 'auto';
    this.teleprompterCustomText = '';
    this.teleprompterRainbowText = (`When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. ` +
      `The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, ` +
      `with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end.`);

    this.teleprompterIndex = 0;
    this.teleprompterSentenceIndex = 0; // current sentence for manual (Space/Tap) advance
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
      vowels: [],      // 0-1
      attack: [],      // 0-1 onset hardness
      weight: [],      // 0-1 perceived heaviness
    };
    this._vowelPlotPoints = []; // {x, y} for F1/F2 scatter
    this._vowelPlotMax = 80;
    // Vocal-attack orb animation: condenses gas→solid on each onset at a speed set by the
    // measured onset hardness, then evaporates. (Weight orb reads m.weight directly.)
    this._attackOrb = { solidity: 0, prevAttack: 0, hardness: 0, lastT: 0 };

    // ====== WINDOWED-AVERAGE READOUTS ======
    // Numeric readouts for pitch/resonance/attack/weight show a rolling time-window average
    // (calmer + more useful for voice training) instead of a jittery per-frame value. The live
    // bars/orbs/graphs stay instantaneous. Buffers are TIME-stamped and fed every frame.
    this._avgWindowSecs = 3.0;        // selectable window length; 0 ⇒ "Live" (instantaneous)
    this._avgWindowMaxSecs = 10;      // retain up to this much history so window switches are instant
    this._avgRefreshSecs = 0.6;       // throttle: only recompute the displayed number this often
    this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
    this._avgCache = {};              // last computed summary per metric (or null)
    this._avgLastRefresh = 0;         // performance.now()/1000 of last cache recompute
    this._avgLastFrameId = -1;        // frame id of last Live-mode recompute (de-dupes per frame)
    // Per-metric display modes (mirrors the Resonance method selector the user likes)
    this.pitchDisplayMode = 'hz';     // 'hz' | 'note' | 'range'
    this.weightMode = 'combined';     // 'combined' | 'tilt' | 'h1h2'
    this.attackMode = 'combined';     // 'combined' | 'rise' | 'abrupt'

    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this._disposables.push(() => window.removeEventListener('resize', onResize));
    this.setupUI();
    this._updateHelpContent();
    this._setupMobile();
    this._setupInfoPopups();
    this.drawIdleScene();
  }



  /** Show/hide info-popup tooltips via JS (CSS-only approach was unreliable) */
  _setupInfoPopups() {
    document.querySelectorAll('.info-wrapper').forEach((wrapper, index) => {
      const popup = wrapper.querySelector('.info-popup');
      const trigger = wrapper.querySelector('.info-trigger');
      if (!popup || !trigger) return;

      const popupId = popup.id || `info-popup-${index}`;
      popup.id = popupId;
      trigger.setAttribute('aria-describedby', popupId);
      trigger.setAttribute('aria-expanded', 'false');

      const show = () => {
        popup.removeAttribute('hidden');
        popup.style.display = '';
        popup.style.opacity = '1';
        popup.style.visibility = 'visible';
        popup.style.pointerEvents = 'auto';
        trigger.setAttribute('aria-expanded', 'true');
      };
      const hide = () => {
        popup.style.display = 'none';
        popup.style.opacity = '0';
        popup.style.visibility = 'hidden';
        popup.style.pointerEvents = 'none';
        popup.setAttribute('hidden', '');
        trigger.setAttribute('aria-expanded', 'false');
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

    // 1. Close drawers/panels when tapping outside on mobile
    const onMobilePointerDown = (e) => {
      if (!mobileQuery.matches) return;
      const vibPanel = document.getElementById('vibPanel');
      const vibToggle = document.getElementById('vibToggle');
      if (vibPanel?.classList.contains('show') && !vibPanel.contains(e.target) && e.target !== vibToggle) {
        vibPanel.classList.remove('show');
        vibToggle?.setAttribute('aria-expanded', 'false');
        vibToggle?.classList.remove('active');
        if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
        vibToggle?.setAttribute('aria-expanded', 'false');
      }
      const recDrawer = document.getElementById('recordingsDrawer');
      const recBtn = document.getElementById('recordingsBtn');
      if (recDrawer?.classList.contains('show') && !recDrawer.contains(e.target) && e.target !== recBtn && !recBtn?.contains(e.target)) {
        recDrawer.classList.remove('show');
        if (recBtn) recBtn.setAttribute('aria-expanded', 'false');
        recBtn?.setAttribute('aria-expanded', 'false');
      }
      const helpTooltip = document.getElementById('helpTooltip');
      const helpBtn = document.getElementById('helpBtn');
      if (helpTooltip?.classList.contains('show') && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        helpBtn?.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('pointerdown', onMobilePointerDown);
    this._disposables.push(() => document.removeEventListener('pointerdown', onMobilePointerDown));

    // 2. Prevent rubber-band bounce on iOS when scrolling at boundaries
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.style.overscrollBehavior = 'contain';
    }

    // 3. Add active state feedback for mobile tap via event delegation
    const mobileActiveSelector = '.btn, .btn-big, .rec-btn, .help-tab';
    const onTouchStart = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.add('mobile-active');
    };
    const onTouchEnd = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.remove('mobile-active');
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
    this._disposables.push(
      () => document.removeEventListener('touchstart', onTouchStart),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );

    // 4. Inject mobile active state CSS (visual feedback on tap)
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = `
      @media (max-width: 600px) and (pointer: coarse) {
        .mobile-active {
          opacity: 0.85;
          transform: scale(0.97) !important;
        }
      }
    `;
    document.head.appendChild(mobileStyle);

    // 5. Scroll fade indicators on horizontally-scrollable areas
    this._initScrollFades();
  }

  /** Attach scroll-fade edge indicators to horizontal scroll containers */
  _initScrollFades() {
    const scrollables = [
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
      this._disposables.push(() => resizeObs.disconnect());
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
    const c = (color, label, desc) => ({ color, label, desc });
    const helpData = {
      ball: {
        title: 'Voice → Ball Mapping',
        items: [
          c('bounce', 'Bounciness', 'Pitch variation controls bounce height. Speak with intonation!'),
          c('vowel', 'Vowel Elongation', 'Sustained sounds grow the ball and leave trails.'),
          c('artic', 'Articulation', 'Sharp consonants create sparkle bursts. Be crisp!'),
        ],
      },
    };
    const data = helpData.ball;
    el.textContent = '';
    const h3 = document.createElement('h3');
    h3.textContent = data.title;
    const p = document.createElement('p');
    const fragment = document.createDocumentFragment();
    data.items.forEach((item, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'));
        fragment.appendChild(document.createElement('br'));
      }
      const b = document.createElement('b');
      b.style.color = `var(--accent-${item.color})`;
      b.textContent = `${item.label}:`;
      fragment.append(b, ' ', item.desc);
    });
    p.appendChild(fragment);
    el.append(h3, p);
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
        // ⚡ Bolt: Replace reduce with traditional loop for performance
        let totalLen = 0;
        for (let i = 0; i < this._recBuffers.length; i++) {
          totalLen += this._recBuffers[i].length;
        }
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
        const msg = e && e.message ? e.message : String(e);
        console.error(`Recording save error (${e && e.name || 'Error'}): ${msg}`, e);
        resolve();
      }
    });
  }

  startDAF() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this._dafInterval) return;
    const fftSize = a.analyserRec.fftSize;
    const sampleRate = a.audioCtx.sampleRate;
    const intervalMs = Math.round(1000 * fftSize / sampleRate);

    this._dafGain = a.audioCtx.createGain();
    this._dafGain.gain.value = 0.9;
    if (this.dafBassFilter) {
      this._dafFilter = a.audioCtx.createBiquadFilter();
      this._dafFilter.type = 'highpass';
      this._dafFilter.frequency.value = 150;
      this._dafGain.connect(this._dafFilter);
      this._dafFilter.connect(a.audioCtx.destination);
    } else {
      this._dafGain.connect(a.audioCtx.destination);
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;

    this._dafInterval = setInterval(() => {
      if (!a.analyserRec) return;
      const samples = new Float32Array(fftSize);
      a.analyserRec.getFloatTimeDomainData(samples);
      this._dafBuffer.push({ samples, captureTime: performance.now() });

      const threshold = performance.now() - this.dafDelayMs;
      while (this._dafBuffer.length > 0 && this._dafBuffer[0].captureTime <= threshold) {
        const { samples: s } = this._dafBuffer.shift();
        const buf = a.audioCtx.createBuffer(1, s.length, sampleRate);
        buf.copyToChannel(s, 0);
        const src = a.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this._dafGain);
        if (this._dafNextPlayTime < a.audioCtx.currentTime) {
          this._dafNextPlayTime = a.audioCtx.currentTime;
        }
        src.start(this._dafNextPlayTime);
        this._dafNextPlayTime += buf.duration;
      }
    }, intervalMs);
  }

  stopDAF() {
    if (this._dafInterval) {
      clearInterval(this._dafInterval);
      this._dafInterval = null;
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    if (this._dafFilter) { this._dafFilter.disconnect(); this._dafFilter = null; }
    if (this._dafGain) { this._dafGain.disconnect(); this._dafGain = null; }
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
    this._updateVoiceRecBtn();

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
      this._updateVoiceRecBtn();
    });

    audio.addEventListener('error', (e) => {
      const detail = audio.error ? `${audio.error.code}: ${audio.error.message}` : String(e);
      console.error(`Audio playback error: ${detail}`);
      this.updateRecItemState(index, false);
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    });

    // Wait for audio to be loadable before playing
    audio.addEventListener('canplay', () => {
      audio.play().catch(e => {
        console.error('Playback failed:', e);
        this.updateRecItemState(index, false);
        this.currentPlayback = null;
        this._updateVoiceRecBtn();
      });
    }, { once: true });

    // Use data URL (works in sandboxed iframes, unlike blob: URLs)
    audio.src = rec.dataUrl;
    audio.load();
  }

  stopPlayback() {
    if (this.currentPlayback) {
      const audio = this.currentPlayback.audio;
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // release media resources
      this.updateRecItemState(this.currentPlayback.index, false);
      const el = document.getElementById(`rec-progress-${this.currentPlayback.index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    }
  }

  updateRecItemState(index, isPlaying) {
    const btn = document.getElementById(`rec-play-${index}`);
    if (btn) {
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.classList.toggle('playing', isPlaying);
    }
  }

  // Keep the always-visible top-bar Record/Play buttons in sync with recording + playback state.
  _updateVoiceRecBtn() {
    const recBtn = document.getElementById('voiceRecBtn');
    if (recBtn) {
      recBtn.classList.toggle('recording', !!this.isRecording);
      recBtn.setAttribute('aria-pressed', String(!!this.isRecording));
      const label = recBtn.querySelector('.voice-rec-label');
      if (label) label.textContent = this.isRecording ? 'Stop' : 'Record';
    }
    const playBtn = document.getElementById('voicePlayBtn');
    if (playBtn) {
      const lastIdx = this.recordings.length - 1;
      const playingLast = !!(this.currentPlayback && this.currentPlayback.index === lastIdx);
      playBtn.disabled = lastIdx < 0 || this.isRecording;
      playBtn.classList.toggle('playing', playingLast);
      const plabel = playBtn.querySelector('.voice-play-label');
      if (plabel) plabel.textContent = playingLast ? ' Stop' : ' Play';
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
    // Revoke immediately — the download has already been initiated by click()
    URL.revokeObjectURL(url);
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
    const clearAllBtn = document.getElementById('clearAllRecs');

    badge.textContent = this.recordings.length;
    recBtn.classList.toggle('visible', this.recordings.length > 0);
    if (clearAllBtn) {
      clearAllBtn.disabled = this.recordings.length === 0;
    }
    this._updateVoiceRecBtn();

    if (this.recordings.length === 0) {
      list.textContent = '';
      list.appendChild(empty);
      empty.style.display = '';
      return;
    }

    list.textContent = '';
    for (let i = this.recordings.length - 1; i >= 0; i--) {
      const rec = this.recordings[i];
      const item = document.createElement('div');
      item.className = 'rec-item';

      const info = Object.assign(document.createElement('div'), { className: 'rec-item-info' });
      info.append(
        Object.assign(document.createElement('div'), { className: 'rec-item-name', textContent: `Recording ${i + 1}` }),
        Object.assign(document.createElement('div'), { className: 'rec-item-meta', textContent: `${rec.timestamp} · ${this.formatDuration(rec.duration)}` })
      );

      const progress = Object.assign(document.createElement('div'), { className: 'rec-progress' });
      progress.appendChild(Object.assign(document.createElement('div'), { className: 'rec-progress-fill', id: `rec-progress-${i}` }));
      info.appendChild(progress);

      const actions = Object.assign(document.createElement('div'), { className: 'rec-item-actions' });
      actions.append(
        Object.assign(document.createElement('button'), { className: 'rec-btn', id: `rec-play-${i}`, title: 'Play', ariaLabel: 'Play Recording', textContent: '▶' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn', title: 'Download', ariaLabel: 'Download Recording', textContent: '⬇' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn delete', title: 'Delete', ariaLabel: 'Delete Recording', textContent: '✕' })
      );

      // Set data attributes
      actions.children[0].dataset.action = 'play'; actions.children[0].dataset.index = i;
      actions.children[1].dataset.action = 'download'; actions.children[1].dataset.index = i;
      actions.children[2].dataset.action = 'delete'; actions.children[2].dataset.index = i;

      item.append(info, actions);
      list.appendChild(item);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index, 10);
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


  // Wire the Smart Bulb section of the settings panel to the BulbController.
  // All transport/config state lives in the controller (persisted to localStorage);
  // this just binds the DOM controls and shows/hides transport-specific fields.
  _setupBulbUI() {
    const ctrl = this.bulbController;
    if (!ctrl) return;
    const enable = document.getElementById('bulbEnableToggle');
    const transportSel = document.getElementById('bulbTransportSelect');
    const testBtn = document.getElementById('bulbTestBtn');
    const connectBtn = document.getElementById('bulbConnectBtn');
    const autoReconnect = document.getElementById('bulbAutoReconnect');
    const fields = {
      hueBridge: document.getElementById('bulbHueBridge'),
      hueUser: document.getElementById('bulbHueUser'),
      hueLightId: document.getElementById('bulbHueLightId'),
      webhookUrl: document.getElementById('bulbWebhookUrl'),
      httpUrl: document.getElementById('bulbHttpUrl'),
      bleNamePrefix: document.getElementById('bulbBleNamePrefix'),
      bleServiceUuid: document.getElementById('bulbBleServiceUuid'),
      bleWriteUuid: document.getElementById('bulbBleWriteUuid'),
    };
    const groups = {
      hue: document.getElementById('bulbHueFields'),
      homeassistant: document.getElementById('bulbHaFields'),
      http: document.getElementById('bulbHttpFields'),
      genericble: document.getElementById('bulbGenericbleFields'),
    };
    // The Connect button (Bluetooth pairing) is shared by all BLE transports.
    const btFields = document.getElementById('bulbBtFields');
    const btTransports = new Set(['webbluetooth', 'genericble', 'esp32']);

    const syncVisibility = () => {
      const t = ctrl.config.transport;
      for (const [key, el] of Object.entries(groups)) {
        if (el) el.style.display = key === t ? '' : 'none';
      }
      if (btFields) btFields.style.display = btTransports.has(t) ? '' : 'none';
    };

    // Reflect controller config into the DOM controls. Runs initially and again
    // whenever the controller changes config itself (e.g. failure auto-disable).
    const hydrate = () => {
      if (enable) enable.checked = ctrl.config.enabled;
      if (transportSel) transportSel.value = ctrl.config.transport;
      if (autoReconnect) autoReconnect.checked = ctrl.config.autoReconnect;
      for (const [key, el] of Object.entries(fields)) {
        if (el) el.value = ctrl.config[key] ?? '';
      }
      syncVisibility();
    };
    hydrate();
    ctrl.onChange = hydrate;

    // Clinic convenience: silently re-link the saved BLE device on load so staff
    // don't re-pick it each session. No-op for non-BLE transports or when off.
    ctrl.restore?.();

    enable?.addEventListener('change', () => ctrl.setEnabled(enable.checked));
    autoReconnect?.addEventListener('change', () => ctrl.set('autoReconnect', autoReconnect.checked));
    transportSel?.addEventListener('change', () => {
      ctrl.set('transport', transportSel.value);
      syncVisibility();
    });
    for (const [key, el] of Object.entries(fields)) {
      el?.addEventListener('change', () => ctrl.set(key, el.value.trim()));
    }
    testBtn?.addEventListener('click', () => ctrl.test());
    // Bluetooth needs an explicit connect from a user gesture (this click).
    connectBtn?.addEventListener('click', () => ctrl.connect());
  }

  // Wire the Necklace section of the settings panel to the NecklaceController.
  // Unlike the Smart Bulb section, the necklace decides on its own when to buzz —
  // this UI only pushes a one-time calibration packet and shows the live status
  // notifications the necklace sends back (~1 Hz) while connected.
  _setupNecklaceUI() {
    const ctrl = this.necklaceController;
    if (!ctrl) return;
    const connectBtn = document.getElementById('necklaceConnectBtn');
    const pushBtn = document.getElementById('necklacePushBtn');
    const hapticSrcSel = document.getElementById('necklaceHapticSrcSelect');
    const loInput = document.getElementById('necklaceTargetLoHz');
    const hiInput = document.getElementById('necklaceTargetHiHz');
    const thrInput = document.getElementById('necklaceHapticThr');
    const pitchFields = document.getElementById('necklacePitchFields');
    const thrFields = document.getElementById('necklaceThrFields');
    const statusEl = document.getElementById('necklaceStatus');
    const liveEl = document.getElementById('necklaceLive');

    if (loInput && !loInput.value) loInput.value = 145;
    if (hiInput && !hiInput.value) hiInput.value = 175;
    if (thrInput && !thrInput.value) thrInput.value = 50;

    const setStatus = (text, kind) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.dataset.kind = kind || '';
    };

    const syncFieldVisibility = () => {
      const isPitch = hapticSrcSel?.value === String(HapticSrc.PITCH);
      if (pitchFields) pitchFields.style.display = isPitch ? '' : 'none';
      if (thrFields) thrFields.style.display = isPitch ? 'none' : '';
    };
    syncFieldVisibility();
    hapticSrcSel?.addEventListener('change', syncFieldVisibility);

    connectBtn?.addEventListener('click', async () => {
      setStatus('Opening device picker…', '');
      try {
        await ctrl.connect();
        setStatus('Necklace connected.', 'ok');
      } catch (err) {
        setStatus(`Connect failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    pushBtn?.addEventListener('click', async () => {
      try {
        await ctrl.sendCalibration({
          hapticSrc: Number(hapticSrcSel?.value ?? HapticSrc.PITCH),
          hapticThrPct: Number(thrInput?.value ?? 50),
          targetLoHz: Number(loInput?.value ?? 145),
          targetHiHz: Number(hiInput?.value ?? 175),
        });
        setStatus('Calibration pushed.', 'ok');
      } catch (err) {
        setStatus(`Push failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    if (liveEl) liveEl.textContent = '';
  }

  // Live readout from the necklace's ~1 Hz status notification (see
  // NecklaceController._onStatusPacket). Purely informational — the necklace has
  // already decided on its own whether to buzz by the time this arrives.
  _onNecklaceStatus(status) {
    const liveEl = document.getElementById('necklaceLive');
    if (!liveEl) return;
    const mins = Math.floor(status.voicedSeconds / 60);
    const secs = status.voicedSeconds % 60;
    const time = `${mins}:${String(secs).padStart(2, '0')}`;
    const battery = status.batteryPct == null ? '' : ` · battery ${status.batteryPct}%`;
    liveEl.textContent = status.calibrating
      ? 'Calibrating…'
      : `On target ${status.onTargetPct}% · ${time} voiced${battery}`;
  }

  setupUI() {
    const startBtn = document.getElementById('startBtn');
    const playBtn = document.getElementById('playBtn');
    const helpBtn = document.getElementById('helpBtn');
    const recalibrateBtn = document.getElementById('recalibrateBtn');
    const homeBtn = document.getElementById('homeBtn');
    const welcomeOverlay = document.getElementById('welcomeOverlay');
    const helpTooltip = document.getElementById('helpTooltip');
    const helpTabs = Array.from(helpTooltip?.querySelectorAll('.help-tab') || []);
    const helpPanels = Array.from(helpTooltip?.querySelectorAll('.help-panel') || []);

    const teleprompterModeSelect = document.getElementById('teleprompterModeSelect');
    const voiceProfileSelect = document.getElementById('voiceProfileSelect');
    const micDeviceSelect = document.getElementById('micDeviceSelect');
    const colorModeSelect = document.getElementById('colorModeSelect');
    const genderCueInputs = {
      modalF0: document.getElementById('genderCueModalF0'),
      dispersion: document.getElementById('genderCueDispersion'),
      sibilant: document.getElementById('genderCueSibilant'),
      cpp: document.getElementById('genderCueCpp'),
      intonation: document.getElementById('genderCueIntonation'),
    };
    const echoCancelToggle = document.getElementById('echoCancelToggle');
    const noiseSuppressToggle = document.getElementById('noiseSuppressToggle');
    const autoGainToggle = document.getElementById('autoGainToggle');
    const pitchProfileLearned = document.getElementById('pitchProfileLearned');
    const tiltProfileLearned = document.getElementById('tiltProfileLearned');
    const frameConfidenceLabel = document.getElementById('frameConfidenceLabel');
    const motionToggle = document.getElementById('motionToggle');
    const cameraBtn = document.getElementById('cameraBtn');
    const cameraModal = document.getElementById('cameraModal');
    const cameraClose = document.getElementById('cameraClose');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraZoom = document.getElementById('cameraZoom');
    const cameraHeader = document.getElementById('cameraHeader');

    const teleprompterCustomBtn = document.getElementById('teleprompterCustomBtn');
    const recordingsBtn = document.getElementById('recordingsBtn');
    const recordingsDrawer = document.getElementById('recordingsDrawer');
    const clearAllRecs = document.getElementById('clearAllRecs');
    const perfBtn = document.getElementById('perfBtn');
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
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in new tab for full access ↗';
      iframeNotice.appendChild(link);
      iframeNotice.classList.add('show');
    }

    const showError = (msg) => {
      if (msg instanceof Node) {
        errorBanner.textContent = '';
        errorBanner.appendChild(msg);
        if (statusLiveRegion) statusLiveRegion.textContent = msg.textContent.trim();
      } else {
        errorBanner.textContent = msg;
        if (statusLiveRegion) statusLiveRegion.textContent = String(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      errorBanner.classList.add('show');
    };
    const clearError = () => {
      errorBanner.classList.remove('show');
      if (statusLiveRegion) statusLiveRegion.textContent = '';
    };

    const updateAdaptiveProfileStatus = () => {
      const pitch = this.analyzer.pitchProfile;
      const tilt = this.analyzer.tiltProfile;
      const pitchPct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
      const tiltPct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
      if (pitchProfileLearned) {
        pitchProfileLearned.textContent = pitch.isLearned
          ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
          : `Learning… ${pitchPct}%`;
      }
      if (tiltProfileLearned) {
        tiltProfileLearned.textContent = tilt.isLearned
          ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
          : `Learning… ${tiltPct}%`;
      }
      if (frameConfidenceLabel) {
        frameConfidenceLabel.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
      }
    };

    const syncMicSettingsUi = () => {
      if (echoCancelToggle) echoCancelToggle.checked = this.micInputPreferences.echoCancellation;
      if (noiseSuppressToggle) noiseSuppressToggle.checked = this.micInputPreferences.noiseSuppression;
      if (autoGainToggle) autoGainToggle.checked = this.micInputPreferences.autoGainControl;
      if (micDeviceSelect) micDeviceSelect.value = this.micInputPreferences.deviceId || 'default';
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
      if (colorModeSelect) colorModeSelect.value = this.colorMode || 'pitch';
      for (const [cue, input] of Object.entries(genderCueInputs)) {
        if (input) input.checked = !!this.genderCues[cue];
      }
    };

    const populateMicDevices = async () => {
      if (!micDeviceSelect || !navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        micDeviceSelect.textContent = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'Microphone: System Default';
        micDeviceSelect.appendChild(defaultOption);
        const phoneOption = document.createElement('option');
        phoneOption.value = 'phone-mic';
        phoneOption.textContent = 'Phone Microphone (link via browser)';
        micDeviceSelect.appendChild(phoneOption);
        mics.forEach((mic, idx) => {
          const option = document.createElement('option');
          option.value = mic.deviceId;
          option.textContent = `Mic: ${mic.label || `Microphone ${idx + 1}`}`;
          micDeviceSelect.appendChild(option);
        });
        const hasStoredDevice = this.micInputPreferences.deviceId === 'default'
          || this.micInputPreferences.deviceId === 'phone-mic'
          || mics.some((mic) => mic.deviceId === this.micInputPreferences.deviceId);
        if (!hasStoredDevice) {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
        }
        syncMicSettingsUi();
      } catch (err) {
        console.warn('Could not enumerate microphones:', err);
      }
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
      cameraBtn?.setAttribute('aria-expanded', 'false');
      cameraBtn?.classList.remove('active');
      if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'false');
      cameraBtn?.setAttribute('aria-expanded', 'false');
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
        cameraBtn?.setAttribute('aria-expanded', 'true');
        cameraBtn?.classList.add('active');
        if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'true');
        cameraBtn?.setAttribute('aria-expanded', 'true');
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

    const startPhoneMicSession = (onStatus) => new Promise((resolve, reject) => {
      function initPeer() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
        const peerId = 'vox-' + code.toLowerCase();
        let settled = false;
        let timeoutId;
        let peer;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          try { peer?.destroy(); } catch (_) {}
          reject(err);
        };
        peer = new window.Peer(peerId);
        timeoutId = setTimeout(() => fail(new Error('Phone mic pairing timed out. Try pressing Start again.')), 120_000);
        peer.on('open', () => onStatus('waiting', code));
        peer.on('call', (call) => {
          if (settled) { call.close?.(); return; }
          call.answer();
          call.on('stream', (stream) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              onStatus('connected', code);
              resolve({ stream, cleanup: () => peer.destroy() });
            }
          });
          call.on('error', fail);
        });
        peer.on('error', fail);
      }
      if (window.Peer) {
        initPeer();
      } else {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
        s.integrity = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR';
        s.crossOrigin = 'anonymous';
        s.onload = initPeer;
        s.onerror = () => reject(new Error('Could not load PeerJS. Check your internet connection.'));
        document.head.appendChild(s);
      }
    });

    const cleanupPhoneMic = () => {
      if (this._phoneMicCleanup) {
        try { this._phoneMicCleanup(); } catch (err) { console.warn('Phone mic cleanup failed:', err); }
        this._phoneMicCleanup = null;
      }
      const phoneMicUrlEl = document.getElementById('phoneMicUrl');
      const phoneMicCodeEl = document.getElementById('phoneMicCode');
      const phoneMicStatusEl = document.getElementById('phoneMicStatus');
      if (phoneMicUrlEl) phoneMicUrlEl.style.display = 'none';
      if (phoneMicCodeEl) phoneMicCodeEl.style.display = 'none';
      if (phoneMicStatusEl) phoneMicStatusEl.style.display = 'none';
    };

    const startGame = async () => {
      if (this._isStarting) return; // prevent concurrent start/stop race
      this._isStarting = true;
      try {
      this.teleprompterSentenceIndex = 0; // start each session at the first sentence
      clearError();
      const initialDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: initialDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: initialDiag.audioState }),
          ' · Secure: ', Object.assign(document.createElement('b'), { textContent: initialDiag.secureContext ? 'yes' : 'no' }),
          initialDiag.inIframe ? ' · Embedded iframe: yes' : ''
        );
      }
      if (this.idleAnimId) {
        cancelAnimationFrame(this.idleAnimId);
        this.idleAnimId = null;
      }

      // Check if we have an audio file OR microphone
      if (!selectedAudioFile && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
        const errNode = document.createElement('div');
        errNode.append(
          '🎙 Microphone API not available and no audio file selected.',
          document.createElement('br'),
          'This requires HTTPS and a modern browser. '
        );
        errNode.textContent = '';
        errNode.appendChild(document.createTextNode('🎙 Microphone API not available and no audio file selected.'));
        errNode.appendChild(document.createElement('br'));
        errNode.appendChild(document.createTextNode('This requires HTTPS and a modern browser. '));
        if (isInIframe) {
          const link = document.createElement('a');
          link.href = window.location.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Try opening in a new tab ↗';
          errNode.appendChild(link);
        } else {
          errNode.appendChild(document.createTextNode('Please use Chrome, Firefox, Safari, or Edge.'));
        }
        showError(errNode);
        this.drawIdleScene();
        return;
      }

      const buildInputOptions = () => ({
        deviceId: this.micInputPreferences.deviceId !== 'default' && this.micInputPreferences.deviceId !== 'phone-mic'
          ? this.micInputPreferences.deviceId : undefined,
        echoCancellation: this.micInputPreferences.echoCancellation,
        noiseSuppression: this.micInputPreferences.noiseSuppression,
        autoGainControl: this.micInputPreferences.autoGainControl,
      });

      let result;
      if (!selectedAudioFile && this.micInputPreferences.deviceId === 'phone-mic') {
        const phoneMicUrlEl = document.getElementById('phoneMicUrl');
        const phoneMicCodeEl = document.getElementById('phoneMicCode');
        const phoneMicStatusEl = document.getElementById('phoneMicStatus');
        try {
          const { stream, cleanup } = await startPhoneMicSession((status, code) => {
            if (status === 'waiting') {
              const url = new URL('phone.html', window.location.href);
              url.searchParams.set('room', code);
              url.searchParams.set('ec', this.micInputPreferences.echoCancellation ? '1' : '0');
              url.searchParams.set('ns', this.micInputPreferences.noiseSuppression ? '1' : '0');
              url.searchParams.set('ag', this.micInputPreferences.autoGainControl ? '1' : '0');
              if (phoneMicUrlEl) { phoneMicUrlEl.href = url.href; phoneMicUrlEl.textContent = url.href; phoneMicUrlEl.style.display = ''; }
              if (phoneMicCodeEl) { phoneMicCodeEl.style.display = ''; phoneMicCodeEl.querySelector('strong').textContent = code; }
              if (phoneMicStatusEl) { phoneMicStatusEl.style.display = ''; phoneMicStatusEl.textContent = 'Waiting for phone to connect...'; }
              showError(`📱 Open on your phone: ${url.href}`);
            } else if (status === 'connected') {
              if (phoneMicStatusEl) phoneMicStatusEl.textContent = '✅ Phone connected!';
              clearError();
            }
          });
          this._phoneMicCleanup = cleanup;
          result = await this.analyzer.start(null, { stream });
          if (!result.ok) { cleanupPhoneMic(); }
        } catch (err) {
          cleanupPhoneMic();
          showError('📱 Phone mic failed: ' + (err.message || 'Connection error'));
          this.drawIdleScene();
          return;
        }
      } else {
        result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        // Recover automatically if a previously saved device is no longer available.
        if (!selectedAudioFile && !result.ok && result.error === 'NotFoundError' && this.micInputPreferences.deviceId !== 'default') {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
          syncMicSettingsUi();
          result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        }
      }

      // Clear the selected file after starting so it doesn't persistently start with the file
      // if the user later clicks the normal Start button.
      selectedAudioFile = null;
      if (audioUploadInput) audioUploadInput.value = "";

      if (!result.ok) {
        let msg = '';
        if (result.error === 'NotAllowedError') {
          if (isInIframe) {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone blocked by browser — this usually happens inside iframes.',
              document.createElement('br')
            );
            msg.append('🎙 Microphone blocked by browser — this usually happens inside iframes.', document.createElement('br'));
            msg.textContent = '';
            msg.appendChild(document.createTextNode('🎙 Microphone blocked by browser — this usually happens inside iframes.'));
            msg.appendChild(document.createElement('br'));
            const link = document.createElement('a');
            link.href = window.location.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open in a new tab for full mic access ↗';
            msg.appendChild(link);
          } else {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone permission denied.',
              document.createElement('br'),
              'Click the lock/camera icon in your address bar → Allow microphone → then try again.'
            );
            msg.appendChild(document.createTextNode('🎙 Microphone permission denied.'));
            msg.appendChild(document.createElement('br'));
            msg.appendChild(document.createTextNode('Click the lock/camera icon in your address bar → Allow microphone → then try again.'));
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
          showError('🎙 Microphone stream ended unexpectedly. Press Start to resume.');
        };
      });

      const activeDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: activeDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: activeDiag.audioState }),
          ' · API: ', Object.assign(document.createElement('b'), { textContent: activeDiag.mediaDevices ? 'ok' : 'missing' })
        );
      }
      populateMicDevices();

      if (!this.hasCompletedCalibration) {
        let calResult = { outcome: 'incomplete', skipped: true, reason: 'timeout-guard' };
        try {
          // Global guard so calibration can never stall session start.
          const timeoutMs = 15000;
          calResult = await Promise.race([
            this.calibrationWizard.run(this.analyzer),
            new Promise((resolve) => setTimeout(() => {
              this.calibrationWizard.cancel();
              resolve({ outcome: 'incomplete', skipped: true, reason: 'wizard-timeout' });
            }, timeoutMs)),
          ]);
        } catch (err) {
          console.error('Calibration flow failed:', err);
          calResult = { outcome: 'incomplete', skipped: true, reason: 'wizard-exception' };
        }
        this.hasCompletedCalibration = true;
        showCalibrationOutcome(calResult);
      }

      // If the wizard was skipped/timed out, don't leave the analyzer in the
      // pre-calibration state where update() early-returns forever.
      if (!this.analyzer.isCalibrated) {
        const fallbackFloor = Math.max(0.008, this.analyzer.noiseFloor || 0.01);
        this.analyzer.noiseFloor = fallbackFloor;
        this.analyzer.syllableThreshold = Math.max(this.analyzer.syllableThreshold || 0, fallbackFloor * 1.2);
        this.analyzer.sustainedThreshold = Math.max(this.analyzer.sustainedThreshold || 0, fallbackFloor * 1.5);
        this.analyzer.isCalibrated = true;
      }

      this.scrollX = 0;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.prosodyScore = 0;
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

      // Clear vibration alert tripped highlights
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();

      // Clear windowed-average readout buffers so a quick restart doesn't average in
      // the previous session's history.
      this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
      this._avgCache = {};
      this._avgLastRefresh = 0;
      this._avgLastFrameId = -1;

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
      this.session.scrollAtStart = this.scrollX;

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
      startBtn.textContent = '⏹ Stop Ball';
      startBtn.classList.add('active');
      recBtn.classList.add('visible');
      this.isRunning = true;
      if (this.dafEnabled) this.startDAF();
      this.lastTime = performance.now();
      this.loop();
      } finally {
        this._isStarting = false;
      }
    };

    const stopGame = async () => {
      // Clear any pending timeouts from the game session
      for (const id of this._pendingTimeouts) clearTimeout(id);
      this._pendingTimeouts = [];
      // Auto-stop recording if active — must await so recorder can
      // flush its final chunk before we kill the mic stream
      if (this.isRecording) {
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-label').textContent = 'Rec';
        await this.stopRecording();
      }
      this.stopDAF();
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
      this.isRunning = false;
      this.analyzer.stop();
      cleanupPhoneMic();
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

      // Close any open panels so they don't block the menu or summary overlay
      // (panels have higher z-index than the welcome overlay, so they must be
      // explicitly closed here — setHudSettingsVisible only hides .hud-setting
      // buttons, not the panel contents themselves).
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');

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
        this.analyzer.stop();
        cleanupPhoneMic();
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

      // Close all panels and reset aria-expanded
      this.stopDAF();
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');

      this.drawIdleScene();
    });

    // Session summary buttons
    document.getElementById('summaryBackBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      // Close any open panels before showing the menu
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
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
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
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

    // Single-mode (Vox Ball) setup — runs once during init.
    document.querySelectorAll('.ball-only').forEach(el => el.classList.add('show'));
    if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
    document.querySelector('.hud-title').textContent = 'VOX BALL';
    this._updateHelpContent();
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    if (!this.isRunning) this.drawIdleScene();

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

    micDeviceSelect?.addEventListener('change', (e) => {
      this.micInputPreferences.deviceId = e.target.value || 'default';
      localStorage.setItem('vox:micDeviceId', this.micInputPreferences.deviceId);
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
    });

    colorModeSelect?.addEventListener('change', (e) => {
      this.colorMode = e.target.value === 'gender' ? 'gender' : 'pitch';
      localStorage.setItem('vox:colorMode', this.colorMode);
      if (!this.isRunning) this.drawIdleScene();
    });

    for (const [cue, input] of Object.entries(genderCueInputs)) {
      input?.addEventListener('change', (e) => {
        this.genderCues[cue] = !!e.target.checked;
        localStorage.setItem(`vox:genderCue:${cue}`, String(this.genderCues[cue]));
        if (!this.isRunning) this.drawIdleScene();
      });
    }

    echoCancelToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.echoCancellation = !!e.target.checked;
      localStorage.setItem('vox:echoCancellation', String(this.micInputPreferences.echoCancellation));
    });

    noiseSuppressToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.noiseSuppression = !!e.target.checked;
      localStorage.setItem('vox:noiseSuppression', String(this.micInputPreferences.noiseSuppression));
    });

    autoGainToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.autoGainControl = !!e.target.checked;
      localStorage.setItem('vox:autoGainControl', String(this.micInputPreferences.autoGainControl));
    });

    // Tap-to-advance for the teleprompter (mobile tap + desktop click)
    if (teleprompterOverlay) {
      teleprompterOverlay.addEventListener('click', () => {
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
        }
      });
    }

    teleprompterModeSelect?.addEventListener('change', (e) => {
      this.teleprompterMode = e.target.value;
      this.teleprompterIndex = 0;
      this.teleprompterSentenceIndex = 0;
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
      this.teleprompterSentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    document.getElementById('resMethodSelect').addEventListener('change', (e) => {
      this.analyzer.resonanceMethod = e.target.value;
      // Reset smoothed values when switching methods for clean comparison
      this.analyzer.smoothF1 = 500;
      this.analyzer.smoothF2 = 1500;
      this.analyzer.smoothF3 = 2700;
      this.analyzer.smoothResonance = 0.5;
      this.analyzer.formantConfidence = 0;
      this.analyzer.formantSteadiness = 1;
      this.analyzer._prevResF1 = 0;
      this.analyzer._prevResF2 = 0;
    });

    // Readout-display mode selectors (mirror the resonance method selector). These are
    // display/selection only — they never change analyzer.metrics.* — and force an immediate
    // cache recompute so the readout updates on the next frame instead of after the throttle.
    const bindReadoutSelect = (id, apply) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => { apply(e.target.value); this._avgLastRefresh = 0; this._avgLastFrameId = -1; });
    };
    bindReadoutSelect('pitchDisplaySelect', (v) => { this.pitchDisplayMode = v; });
    bindReadoutSelect('weightModeSelect', (v) => { this.weightMode = v; });
    bindReadoutSelect('attackModeSelect', (v) => { this.attackMode = v; });
    bindReadoutSelect('avgWindowSelect', (v) => { this._avgWindowSecs = parseFloat(v) || 0; });

    // ---- Voice recorder: always-available Record + Play-last controls in the top bar ----
    // Reuses the analyser-based recorder (startRecording/stopRecording) and the recordings
    // drawer (Clips) for the full list; the Play button plays back the most recent clip.
    const voiceRecBtn = document.getElementById('voiceRecBtn');
    if (voiceRecBtn) {
      voiceRecBtn.addEventListener('click', async () => {
        if (this.isRecording) {
          await this.stopRecording();   // pushes the clip + calls updateRecordingsUI → syncs buttons
          this._updateVoiceRecBtn();    // also reset if no clip was saved (silent recording)
        } else if (!this.isRunning) {
          showError('🎙 Press Start to begin a session, then Record.');
        } else {
          this.startRecording();
          this._updateVoiceRecBtn();
        }
      });
    }
    const voicePlayBtn = document.getElementById('voicePlayBtn');
    if (voicePlayBtn) {
      voicePlayBtn.addEventListener('click', () => {
        const lastIdx = this.recordings.length - 1;
        if (lastIdx < 0) return;
        if (this.currentPlayback && this.currentPlayback.index === lastIdx) {
          this.stopPlayback();
        } else {
          this.playRecording(lastIdx);
        }
      });
    }

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
      metersExpandToggle.setAttribute('aria-label', this.metersExpanded ? 'Collapse metrics' : 'Expand metrics');
      // Reflow the game canvas after panel height changes so the ball/ground stay in view.
      requestAnimationFrame(() => this.resize());
      // Expansion animation shifts layout over ~300ms; run one more resize after it settles.
      setTimeout(() => this.resize(), 320);
      // Size canvases after layout settles
      if (this.metersExpanded) {
        requestAnimationFrame(() => this._sizeExpandedCanvases());
      }
    });

    // ====== BALL CAMERA ZOOM CONTROLS ======
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const ZOOM_STEP = 0.15;
    const ZOOM_MIN = 0.55;
    const ZOOM_MAX = 2.2;
    zoomInBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.min(ZOOM_MAX, this.userZoomMultiplier + ZOOM_STEP);
    });
    zoomOutBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.max(ZOOM_MIN, this.userZoomMultiplier - ZOOM_STEP);
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
    syncMicSettingsUi();
    updateAdaptiveProfileStatus();
    populateMicDevices();
    motionToggle?.addEventListener('click', () => {
      const order = ['auto', 'low', 'full'];
      const idx = order.indexOf(this.userMotionPreference);
      this.userMotionPreference = order[(idx + 1) % order.length];
      localStorage.setItem('vox:motionPreference', this.userMotionPreference);
      this._applyMotionPreferences();
      syncMotionToggleLabel();
    });

    // ---- Smart Bulb UI ----
    this._setupBulbUI();
    this._setupNecklaceUI();


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
      settingsBtn?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      modalBackdrop.classList.toggle('show', isVisible);
      if (settingsBtn) settingsBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      settingsBtn?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');

      if (settingsBtn) {
        settingsBtn.setAttribute('aria-expanded', isVisible);
      }

      // Force DOM visibility (bypass any CSS specificity issues)
      if (isVisible) {
        settingsPanel.removeAttribute('hidden');
        settingsPanel.style.display = 'flex';
        settingsPanel.style.opacity = '1';
        settingsPanel.style.pointerEvents = 'auto';
        syncMicSettingsUi();
        updateAdaptiveProfileStatus();
        populateMicDevices();
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        vibPanel.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
        recordingsDrawer.classList.remove('show');
        document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
        vibPanel.classList.remove('show');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
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
      if (settingsPanel && !settingsPanel.contains(e.target) && e.target !== settingsBtn && (!settingsBtn || !settingsBtn.contains(e.target))) {
        if (settingsPanel.classList.contains('show')) toggleSettings(false);
      }
      // Vibration panel
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || e.target !== vibBtn)) {
        if (vibPanel.classList.contains('show')) {
          vibPanel.classList.remove('show');
          if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        }
        vibPanel.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
      }
      // DAF panel
      const _dafPanel = document.getElementById('dafPanel');
      const _dafBtn = document.getElementById('dafBtn');
      if (_dafPanel && !_dafPanel.contains(e.target) && e.target !== _dafBtn && (!_dafBtn || !_dafBtn.contains(e.target))) {
        if (_dafPanel.classList.contains('show')) {
          _dafPanel.classList.remove('show');
          _dafBtn?.setAttribute('aria-expanded', 'false');
        }
      }
    });

    if (vibBtn) {
      vibBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (vibPanel) {
          const isVisible = vibPanel.classList.toggle('show');
          vibBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
        }

        if (helpTooltip) {
          helpTooltip.classList.remove('show');
          document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
        }

        if (recordingsDrawer) {
          recordingsDrawer.classList.remove('show');
          document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
        }

        if (settingsPanel && settingsPanel.classList.contains('show')) {
          toggleSettings(false);
        }
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
      vibRulesList.textContent = '';
      const hintEl = document.getElementById('vibEmptyHint');
      if (hintEl) hintEl.style.display = this.vibration.rules.length === 0 ? 'block' : 'none';
      for (const rule of this.vibration.rules) {
        const info = getMetricInfo(rule.metric);
        const el = document.createElement('div');
        el.className = 'vib-rule' + (rule.tripped ? ' tripped' : '');
        el.dataset.ruleId = rule.id;

        const frag = document.createDocumentFragment();

        const configDiv = document.createElement('div');
        configDiv.className = 'vib-rule-config';

        const topDiv1 = document.createElement('div');
        topDiv1.className = 'vib-rule-top';

        const metricSelect = document.createElement('select');
        metricSelect.className = 'vib-metric';
        metricSelect.setAttribute('aria-label', 'Metric');
        for (const m of vibMetrics) {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.value === rule.metric) opt.selected = true;
          metricSelect.append(opt);
        }

        const dirSelect = document.createElement('select');
        dirSelect.className = 'vib-dir';
        dirSelect.setAttribute('aria-label', 'Direction');
        const optBelow = document.createElement('option');
        optBelow.value = 'below';
        optBelow.textContent = 'drops below';
        if (rule.direction === 'below') optBelow.selected = true;
        const optAbove = document.createElement('option');
        optAbove.value = 'above';
        optAbove.textContent = 'goes above';
        if (rule.direction === 'above') optAbove.selected = true;
        dirSelect.append(optBelow, optAbove);

        topDiv1.append(metricSelect, dirSelect);

        const topDiv2 = document.createElement('div');
        topDiv2.className = 'vib-rule-top';

        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.className = 'vib-threshold';
        thresholdInput.value = rule.threshold;
        thresholdInput.min = info.min;
        thresholdInput.max = info.max;
        thresholdInput.step = info.step;
        thresholdInput.setAttribute('aria-label', 'Threshold');

        const unitSpan = document.createElement('span');
        unitSpan.className = 'vib-rule-unit';
        unitSpan.textContent = info.unit;

        const liveValSpan = document.createElement('span');
        liveValSpan.className = 'vib-live-val';
        liveValSpan.dataset.ruleId = rule.id;
        liveValSpan.style.cssText = 'font-size:0.62rem;color:rgba(255,255,255,0.35);margin-left:4px;min-width:32px;text-align:right';
        liveValSpan.textContent = '—';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';
        toggleLabel.style.marginLeft = '4px';

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.className = 'vib-rule-toggle';
        toggleInput.setAttribute('aria-label', 'Enable alert rule');
        if (rule.enabled) toggleInput.checked = true;

        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'toggle-slider';

        toggleLabel.append(toggleInput, toggleSlider);
        topDiv2.append(thresholdInput, unitSpan, liveValSpan, toggleLabel);

        configDiv.append(topDiv1, topDiv2);

        const delBtn = document.createElement('button');
        delBtn.className = 'vib-rule-del';
        delBtn.title = 'Delete rule';
        delBtn.setAttribute('aria-label', 'Delete rule');
        delBtn.textContent = '✕';

        frag.append(configDiv, delBtn);
        el.append(frag);

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
            case 'tempo': val = 0; break;
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

    // ── DAF (Delayed Auditory Feedback) panel handlers ──
    const dafBtn = document.getElementById('dafBtn');
    const dafPanel = document.getElementById('dafPanel');

    dafBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dafPanel.classList.toggle('show');
      dafBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      if (isVisible) {
        document.getElementById('dafEnableToggle').checked = this.dafEnabled;
        document.getElementById('dafDelaySlider').value = this.dafDelayMs;
        document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
        document.getElementById('dafBassFilterToggle').checked = this.dafBassFilter;
        vibPanel?.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        helpTooltip?.classList.remove('show');
        recordingsDrawer?.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        settingsPanel?.classList.remove('show');
        if (settingsBtn) settingsBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.getElementById('dafEnableToggle')?.addEventListener('change', (e) => {
      this.dafEnabled = e.target.checked;
      localStorage.setItem('vox:daf:enabled', String(this.dafEnabled));
      dafBtn?.classList.toggle('active', this.dafEnabled);
      if (this.isRunning) {
        if (this.dafEnabled) this.startDAF();
        else this.stopDAF();
      }
    });

    document.getElementById('dafDelaySlider')?.addEventListener('input', (e) => {
      this.dafDelayMs = parseInt(e.target.value);
      localStorage.setItem('vox:daf:delayMs', String(this.dafDelayMs));
      document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
      this._dafBuffer = [];
    });

    document.getElementById('dafBassFilterToggle')?.addEventListener('change', (e) => {
      this.dafBassFilter = e.target.checked;
      localStorage.setItem('vox:daf:bassFilter', String(this.dafBassFilter));
      if (this._dafInterval) {
        this.stopDAF();
        this.startDAF();
      }
    });

    if (this.dafEnabled) dafBtn?.classList.add('active');
    // ── end DAF handlers ──

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
      // Clear stale calibration data so fresh samples are collected
      this.analyzer.resetCalibration();
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
      const isVisible = helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      recordingsDrawer.classList.remove('show');
      const recBtn = document.getElementById('recordingsBtn');
      if (recBtn) recBtn.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      const vibToggle = document.getElementById('vibToggle');
      if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
      if (helpBtn) helpBtn.setAttribute('aria-expanded', isVisible);
      if (recordingsDrawer) {
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel) {
        vibPanel.classList.remove('show');
        if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
      }
      const isShown = helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', isShown ? 'true' : 'false');

      helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', helpTooltip.classList.contains('show') ? 'true' : 'false');
      recordingsDrawer.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      if (settingsPanel && settingsPanel.classList.contains('show')) toggleSettings(false);
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
        if (helpTooltip.classList.contains('show')) {
          helpTooltip.classList.remove('show');
          if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        }
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        if (recordingsDrawer.classList.contains('show')) {
          recordingsDrawer.classList.remove('show');
          if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        }
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!typeof vibBtn === 'undefined' || !vibBtn || !vibBtn.contains(e.target))) {
        if (vibPanel.classList.contains('show')) {
          vibPanel.classList.remove('show');
          if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        }
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        vibPanel.classList.remove('show');
        const vibToggle = document.getElementById('vibToggle');
        if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
        helpBtn?.setAttribute('aria-expanded', 'false');
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        recordingsDrawer.classList.remove('show');
        recordingsBtn?.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        vibPanel.classList.remove('show');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
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
      // Resume AudioContext if it was suspended while tab was hidden
      try {
        if (this.analyzer.audioCtx && this.analyzer.audioCtx.state === 'suspended') {
          await this.analyzer.audioCtx.resume();
        }
      } catch (_) { /* non-blocking */ }
      try {
        if (navigator.permissions?.query) {
          const mic = await navigator.permissions.query({ name: 'microphone' });
          if (mic.state === 'denied') {
            showError('🎙 Microphone permission changed to denied. Re-enable browser mic permission, then press Start.');
          }
        }
      } catch (e) {
        // non-blocking permissions probe
      }
    });

    recordingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      helpTooltip.classList.remove('show');
      const helpBtnEl = document.getElementById('helpBtn');
      if (helpBtnEl) helpBtnEl.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      const vibBtnEl = document.getElementById('vibToggle');
      if (vibBtnEl) vibBtnEl.setAttribute('aria-expanded', 'false');
      if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', isVisible);
      if (helpTooltip) {
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel) {
        vibPanel.classList.remove('show');
        if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
      }
      const isShown = recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', isShown ? 'true' : 'false');

      recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', recordingsDrawer.classList.contains('show') ? 'true' : 'false');
      helpTooltip.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      if (settingsPanel && settingsPanel.classList.contains('show')) toggleSettings(false);
    });

    clearAllRecs.addEventListener('click', () => {
      if (this.recordings.length === 0) return;
      if (window.confirm('Are you sure you want to delete all recordings? This cannot be undone.')) {
        this.clearAllRecordings();
      }
    });


  }

  // FIX: Idle scene animation behind the overlay
  drawIdleScene() {
    // Cancel any existing idle loop first so repeated calls (e.g. toggling color
    // mode while idle) don't stack independent rAF loops.
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    const idleScroll = { x: this.scrollX || 0 };
    let idleTime = 0;
    const animate = () => {
      if (this.isRunning) return;
      idleTime += 0.016;
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
      this.idleAnimId = requestAnimationFrame(animate);
    };
    animate();
  }

  loop() {
    if (!this.isRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // While the calibration wizard is active it drives analyzer.update() from its
    // own loops — skip the main-loop update so frame time isn't counted twice
    // (double-driving corrupts calibration timers and every EMA-smoothed metric).
    if (!this.calibrationWizard?.isWizardLoopActive) {
      this.analyzer.update(dt);
    }

    // Skip rendering when the tab is hidden to save CPU/GPU.
    // Audio analysis above still runs so calibration state stays warm.
    if (document.hidden) {
      requestAnimationFrame(() => this.loop());
      return;
    }

    this.perfMonitor.sample(dt);

    const targetQualityScale = this.perfMonitor.fps > 0 && this.perfMonitor.fps < 30 ? 0.55 : this.perfMonitor.fps > 0 && this.perfMonitor.fps < 42 ? 0.75 : 1;
    this.dynamicQualityScale += (targetQualityScale - this.dynamicQualityScale) * 0.08;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;

    this.update(dt);
    this.drawSceneInternal(this.prosodyScore);
    // Mirror the live ball color onto a smart bulb (throttled internally).
    // Driven from the central loop so it tracks every mode that updates the color.
    const currentResonance = this.analyzer ? this.analyzer.smoothResonance : 0;
    const currentWeight = this.analyzer ? this.analyzer.weightSmoothed : 0.5;
    this.bulbController?.update(this.ballHue, this.ballSat, this.ballLit, currentResonance, dt, currentWeight);
    this._pushAvgSamples();
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
    // During low-confidence frames, slow the smoothing factor so
    // unreliable data doesn't jerk the score around.
    // ==========================================================
    const scoreSmoothing = 0.12 * Math.max(0.2, this.analyzer.frameConfidence);
    this.prosodyScore = computeProsodyScore(this.prosodyScore, m, scoreSmoothing);

    const ps = this.prosodyScore;

    // ==========================================================
    // SCROLL SPEED — prosody + rolling syllable frequency drives movement
    // Monotone: sluggish crawl (20 px/s). High rate: >300 px/s.
    // ==========================================================
    const nowSec = performance.now() / 1000;
    this.syllableTimes = this.syllableTimes || [];
    const currentImpulse = this.analyzer.syllableImpulse;
    if (currentImpulse > 0.9 && !this._hadSyllableTrigger) {
      this.syllableTimes.push(nowSec);
      this._hadSyllableTrigger = true;
    } else if (currentImpulse <= 0.8) {
      this._hadSyllableTrigger = false;
    }
    this.syllableTimes = this.syllableTimes.filter(t => nowSec - t <= 3.0);
    const syllableFreq = this.syllableTimes.length / 3.0;
    const speedFactor = Math.min(1.0, syllableFreq / 3.0);
    this.syllableSpeedFactor = speedFactor;

    this.targetScrollSpeed = 20 + ps * 150 + speedFactor * 250;
    this.scrollSpeed += (this.targetScrollSpeed - this.scrollSpeed) * 0.06;
    this.scrollX += this.scrollSpeed * dt;

    this.ball.x = this.width * 0.45;
    const localGround = this.getGroundHeight(this.scrollX + this.ball.x);

    // ==========================================================
    // SYLLABLE BOUNCE — gated by prosody
    // Monotone syllables = tiny nudge. Prosodic = BIG bounce.
    // At ps=0.4 → ~120px height. At ps=0.8 → ~400px height.
    // ==========================================================
    const sylImpulse = this.analyzer.syllableImpulse;
    if (sylImpulse > 0.5) {
      const bouncePower = 120 + ps * 1800;
      if (this.ball.vy > -bouncePower * 0.5) {
        this.ball.vy = -bouncePower * sylImpulse;
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
    const scrollSpeedFactor = Math.min(1, this.scrollSpeed / 300);
    this.targetZoom = (1.48 - heightRatio * 0.3 - scrollSpeedFactor * 0.08) * this.userZoomMultiplier; // 1.48 → 1.10, scaled by manual zoom
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
    if (this.sparkles.length > MAX_SPARKLES) this.sparkles.splice(0, this.sparkles.length - MAX_SPARKLES);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].life <= 0) this.particles.splice(i, 1);
    }
    if (this.particles.length > 80) this.particles.splice(0, this.particles.length - 80);

    // ==========================================================
    // BALL COLOR — hue from pitch or perceived gender (see _computeBallHue),
    // prosody drives saturation and brightness
    // ==========================================================
    const pitchHue = this._computeBallHue(dt);
    this.ballHue = pitchHue;
    this.ballSat = 25 + ps * 75;   // 25% (muted) → 100% (vivid)
    this.ballLit = this.colorblindMode
      ? (40 + ps * 30) + (pitchHue < 100 ? 10 : 0) // extra luminance boost at yellow end
      : 40 + ps * 30;

    // --- Reliability vividness ---
    // In noise (low SNR trust) desaturate + gently dim the ball, so it visibly reads as
    // "uncertain" rather than as a confident voice change. We smooth snrConfidence again
    // here (it is already smoothed in the analyzer) so the ball eases, never strobes, and
    // we drive saturation + luminance (not hue) so the cue survives colorblind mode.
    const snrConf = this.analyzer.metrics.snrConfidence;
    this.trustVividness += (snrConf - this.trustVividness) * Math.min(1, dt * 4); // ~250ms
    const trust = this.trustVividness;
    this.ballSat *= 0.30 + 0.70 * trust;
    this.ballLit *= 0.70 + 0.30 * trust;
    this._lowTrustSecs = this.analyzer.metrics.snrTier === 'red'
      ? Math.min(6, this._lowTrustSecs + dt)
      : Math.max(0, this._lowTrustSecs - dt * 2);
  }

  // ==========================================================
  // BALL HUE — single source of truth for ball color.
  //
  // colorMode 'pitch' (default): hue follows F0
  //   ≤100 Hz → 210 (deep blue), 145 → 250, 160 → 275 (androgynous center),
  //   175 → 310, ≥250 → 340 (hot pink)
  //
  // colorMode 'gender': hue follows perceived vocal gender (pitch + resonance)
  //   blue (masculine) → purple ~275 (androgynous/nonbinary) → pink (feminine)
  //
  // Each mode has a colorblind sub-ramp (luminance-mapped blue→yellow).
  // ==========================================================
  _computeBallHue(dt) {
    if (this.colorMode === 'gender') {
      return this._updateGenderHue();
    }
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
    return pitchHue;
  }

  // Perceived-gender hue: combine all enabled acoustic cues into a 0..1 score, smooth it,
  // then map to a hue. Smoothing rate rises with confidence so the hue settles quickly on
  // confident voiced frames and coasts gently when the signal is weak. Every cue feeds only
  // this score, so the smart bulb and colorblind ramp inherit it automatically.
  _updateGenderHue() {
    const a = this.analyzer;
    const g = this.genderCues;

    // Build per-cue {value (0..1 femininity), confidence}.
    // pitchZone: absolute F0 position (110–230 Hz → 0–1) from modal F0 — no longer relative
    //   to the user's own range, so it carries real gender-perceptual information.
    // resonance: aVTL-primary score (vowel-robust).
    // weight: lower = lighter/breathier (more feminine); higher = heavier/pressed (more masculine).
    // dispersion and cpp are now absorbed into resonance and weight respectively.
    const cues = {
      pitchZone: { value: clamp01(a.metrics.pitchZone), confidence: a.modalF0Confidence },
      resonance: { value: clamp01(a.smoothResonance), confidence: a.formantConfidence },
      weight: { value: 1 - clamp01(a.metrics.weight), confidence: a.spectralTiltConfidence }, // invert: low weight = light/feminine
      sibilant: { value: computeSibilantFemininity(a.sibilantCentroidHz), confidence: a.sibilantConfidence },
      intonation: { value: clamp01(a.metrics.bounce), confidence: a.pitchConfidence },
    };

    const enabledMap = {
      pitchZone: true,
      resonance: true,
      weight: g.weight != null ? g.weight : true,
      sibilant: g.sibilant,
      intonation: g.intonation,
    };

    const gMode = this.goalMode || 'feminization';
    const gWeights = gMode === 'masculinization' ? MASCULINIZATION_CUE_WEIGHTS : FEMINIZATION_CUE_WEIGHTS;
    const { score, uncertainty } = computeGenderScoreMulti({
      cues,
      weights: gWeights,
      enabledMap,
      goalMode: gMode,
      modalF0Hz: a.modalF0Hz,
    });

    const conf = clamp01(1 - uncertainty);
    const lerp = 0.05 + conf * 0.08;
    this.smoothGenderScore += (score - this.smoothGenderScore) * lerp;
    this.genderUncertainty = uncertainty;
    return genderScoreToHue(this.smoothGenderScore, this.colorblindMode);
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

    // Ball glow — boosted for visibility against dark scene. When SNR trust is low the
    // glow shrinks and breathes with a calm slow pulse (never a strobe), so an unreliable
    // reading looks unsettled rather than confidently bright.
    const trust = this.trustVividness;
    const glowPulse = trust > 0.85 ? 1 : 0.82 + 0.18 * Math.sin(time * 2.2);
    const glowSize = this.ball.radius * (2.2 + prosodyGlow * 1.5) * (0.7 + 0.3 * trust);
    const glowGrad = ctx.createRadialGradient(0, 0, this.ball.radius * 0.2, 0, 0, glowSize);
    glowGrad.addColorStop(0, this.getBallColor(0.35 * glowPulse));
    glowGrad.addColorStop(0.4, this.getBallColor(0.12 * glowPulse));
    glowGrad.addColorStop(0.7, this.getBallColor(0.04 * glowPulse));
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

    // --- Calm reliability nudge (the non-color channel) ---
    // After SNR has sat in the red tier for a moment, say it plainly so a noisy room isn't
    // mistaken for a voice change. Calm amber (never alarm red), fades in, auto-hides as
    // trust recovers. Pairs with the ball's desaturation so the cue isn't colour-only.
    if (this._lowTrustSecs > 1.5) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (this._lowTrustSecs - 1.5) / 0.8) * 0.92;
      ctx.font = '600 13px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = this.colorblindMode ? '#ffd166' : '#ffb86b';
      ctx.fillText('Room’s a bit noisy — readings may drift (try a closer mic)', w / 2, 34);
      ctx.restore();
    }

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
        case 'tempo': currentVal = 0; break;
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
      // ⚡ Bolt: Replace reduce with traditional loop for performance
      let prosodySum = 0;
      for (let i = 0; i < sess.prosodyHistory.length; i++) {
        prosodySum += sess.prosodyHistory[i];
      }
      const avgProsody = Math.round((prosodySum / sess.prosodyHistory.length) * 100);
      stats.push({ value: `${avgProsody}%`, label: 'Avg Prosody' });
    } else {
      stats.push({ value: '—', label: 'Avg Prosody' });
    }

    // Render stats grid (Security enhancement: safe DOM construction)
    grid.textContent = '';
    const gridFrag = document.createDocumentFragment();
    for (const s of stats) {
      const statDiv = document.createElement('div');
      statDiv.className = 'summary-stat' + (s.wide ? ' wide' : '');
      const valDiv = document.createElement('div');
      valDiv.className = 'summary-stat-value';
      valDiv.textContent = s.value;
      const labelDiv = document.createElement('div');
      labelDiv.className = 'summary-stat-label';
      labelDiv.textContent = s.label;
      statDiv.append(valDiv, labelDiv);
      gridFrag.append(statDiv);
    }
    grid.append(gridFrag);

    // Render prosody sparkline
    const history = sess.prosodyHistory;
    if (history.length > 2) {
      document.getElementById('summaryProsodyWrap').style.display = '';
      const barFrag = document.createDocumentFragment();
      const bar = document.getElementById('summaryProsodyBar');
      bar.textContent = '';

      // Downsample to ~60 bars max
      const maxBars = 60;
      const step = Math.max(1, Math.floor(history.length / maxBars));
      const bars = [];
      for (let i = 0; i < history.length; i += step) {
        const slice = history.slice(i, i + step);
        let sliceSum = 0;
        for (let j = 0; j < slice.length; j++) {
          sliceSum += slice[j];
        }
        const v = sliceSum / slice.length;
        bars.push(v);
      }
      // ...
      for (const v of bars) {
        const h = Math.max(2, v * 30);
        const hue = 220 + v * 80; // blue → purple as prosody increases
        const seg = document.createElement('div');
        seg.className = 'bar-seg';
        seg.style.height = `${h}px`;
        seg.style.backgroundColor = `hsl(${Math.round(hue)}, 60%, ${Math.round(45 + v * 20)}%)`;
        barFrag.append(seg);
      }
      bar.append(barFrag);
    } else {
      document.getElementById('summaryProsodyWrap').style.display = 'none';
    }

    overlay.classList.add('show');
  }

  // Split a passage into sentences, keeping terminal punctuation with each
  // sentence and capturing any trailing fragment that lacks final punctuation.
  _splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g);
    return (parts || [text]).map((s) => s.trim()).filter(Boolean);
  }

  _teleprompterSourceText() {
    return this.teleprompterMode === 'custom' ? this.teleprompterCustomText : this.teleprompterRainbowText;
  }

  // Manual advance: speaker presses Space (desktop) or taps (mobile) to reveal
  // the next sentence. Wraps back to the start at the end of the passage.
  _advanceTeleprompterManual() {
    const enabled = this.teleprompterMode !== 'off';
    if (!enabled) return;
    const sentences = this._splitSentences(this._teleprompterSourceText());
    if (!sentences.length) return;
    this.teleprompterSentenceIndex = (this.teleprompterSentenceIndex + 1) % sentences.length;
  }

  renderTeleprompter(dt) {
    const overlay = document.getElementById('teleprompterOverlay');
    if (!overlay) return;
    const hint = document.getElementById('teleprompterHint');
    const enabled = this.teleprompterMode !== 'off';
    overlay.classList.toggle('show', enabled);
    if (hint) hint.classList.toggle('show', enabled && this.isRunning);
    if (!enabled) { this._tpLastIdx = -1; return; }

    // This runs every frame — only re-split and rebuild the overlay DOM when the
    // passage text or sentence index actually changed.
    const sourceText = this._teleprompterSourceText();
    if (this.teleprompterSentenceIndex === this._tpLastIdx && sourceText === this._tpLastText) return;

    const sentences = this._splitSentences(sourceText);
    if (!sentences.length) return;
    if (this.teleprompterSentenceIndex >= sentences.length) {
      this.teleprompterSentenceIndex = sentences.length - 1;
    }
    const idx = this.teleprompterSentenceIndex;
    this._tpLastIdx = idx;
    this._tpLastText = sourceText;

    overlay.textContent = '';
    const frag = document.createDocumentFragment();
    const cur = document.createElement('span');
    cur.className = 'active-sentence';
    cur.textContent = sentences[idx];
    frag.append(cur);
    if (idx + 1 < sentences.length) {
      frag.append(document.createTextNode(' '));
      const nxt = document.createElement('span');
      nxt.className = 'next-sentence';
      nxt.textContent = sentences[idx + 1];
      frag.append(nxt);
    }
    overlay.append(frag);
  }

  updateMeters() {
    this._triggerMetricHighlight('articulation', 0.72);

    // Cache the DOM lookups — this runs every frame, and getElementById/querySelector
    // ten times per frame is pure waste. The static 3px indicator width is set once here too.
    if (!this._meterEls) {
      this._meterEls = {
        pitch: document.getElementById('meterPitch'),
        valPitch: document.getElementById('valPitch'),
        resonance: document.getElementById('meterResonance'),
        valResonance: document.getElementById('valResonance'),
        highlight: {
          tempo: document.querySelector('.meter-tempo .meter-label'),
          articulation: document.querySelector('.meter-artic .meter-label'),
        },
        mapSplatter: document.getElementById('mapSplatter'),
        pitchStatus: document.getElementById('pitchProfileLearned'),
        tiltStatus: document.getElementById('tiltProfileLearned'),
        confidenceStatus: document.getElementById('frameConfidenceLabel'),
      };
      this._meterEls.pitch.style.width = '3px';
      this._meterEls.resonance.style.width = '3px';
    }
    const els = this._meterEls;

    // Pitch meter — position-based indicator (not fill width). The bar tracks the live pitch;
    // the numeric readout shows a windowed average (formatted per the Pitch display mode).
    // Map 80-300 Hz to 0-100% position on the gradient bar
    const hz = this.analyzer.smoothPitchHz;
    const pitchPos = pitchHzToPosition(hz, 80, 300);
    els.pitch.style.left = (pitchPos * 100) + '%';
    els.valPitch.textContent = this._pitchReadout();

    // Resonance meter — position-based indicator like pitch; numeric readout = windowed avg F1/F2
    const res = this.analyzer.smoothResonance;
    els.resonance.style.left = (res * 100) + '%';
    els.valResonance.textContent = this._resonanceReadout('hud');

    for (const [k, el] of Object.entries(els.highlight)) {
      this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
      if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
    }
    if (els.mapSplatter) els.mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

    const pitchStatus = els.pitchStatus;
    const tiltStatus = els.tiltStatus;
    const confidenceStatus = els.confidenceStatus;
    if (pitchStatus || tiltStatus || confidenceStatus) {
      const pitch = this.analyzer.pitchProfile;
      const tilt = this.analyzer.tiltProfile;
      if (pitchStatus) {
        const pct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
        pitchStatus.textContent = pitch.isLearned
          ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
          : `Learning… ${pct}%`;
      }
      if (tiltStatus) {
        const pct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
        tiltStatus.textContent = tilt.isLearned
          ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
          : `Learning… ${pct}%`;
      }
      if (confidenceStatus) confidenceStatus.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
    }
  }

  _meterLabel(val, low, mid, high) {
    const pct = Math.round(val * 100);
    if (pct <= 15) return `${pct}% · ${low}`;
    if (pct <= 55) return `${pct}% · ${mid}`;
    return `${pct}% · ${high}`;
  }

  // ============================================================
  // WINDOWED-AVERAGE READOUTS (pitch / resonance / attack / weight)
  // ============================================================

  // Collect one time-stamped sample per metric every frame (voicing/confidence-gated so the
  // averages reflect actual phonation, not silence). Called unconditionally from the render
  // loop — independent of whether the expanded panel is open — so the always-visible HUD
  // readouts have history to average.
  _pushAvgSamples() {
    const a = this.analyzer, m = a.metrics;
    const t = performance.now() / 1000;
    const B = this._avgBuffers;

    if (a.lastPitch > 0 && a.smoothPitchHz > 0 && a.pitchConfidence > 0.35 && m.energy > 0.05) {
      B.pitch.push({ t, v: a.smoothPitchHz });
    }
    if (a.formantConfidence > 0.2 && m.energy > 0.05) {
      B.resonance.push({ t, f1: a.smoothF1, f2: a.smoothF2 });
    }
    if (m.attack > 0.02) {
      B.attack.push({ t, v: m.attack, rise: a.attackRiseHardness, abrupt: a.attackAbruptness });
    }
    if (a.spectralTiltConfidence > 0.2) {
      B.weight.push({ t, v: m.weight, tilt: 1 - a.spectralWeight, h1h2: a.h1h2SmoothedDb });
    }

    // Evict samples older than the retained max so buffers stay bounded; the active window
    // (which may be shorter, or 0 for "Live") is applied at read time in _recomputeAvgCache().
    const cutoff = t - this._avgWindowMaxSecs;
    for (const k in B) {
      const buf = B[k];
      while (buf.length && buf[0].t < cutoff) buf.shift();
    }
  }

  // Throttled accessor: returns a cached per-metric summary (or null when there aren't enough
  // samples). The whole cache is recomputed at most every _avgRefreshSecs so the displayed
  // numbers read calmly even though samples arrive at 60fps.
  _avgSummary(metric) {
    const t = performance.now() / 1000;
    if (this._avgWindowSecs <= 0) {
      // Live mode tracks every frame, but recompute at most once per frame (HUD + cards +
      // popup all call this), not once per readout.
      const frameId = Math.floor(t * 1000 / 16);
      if (frameId !== this._avgLastFrameId) { this._recomputeAvgCache(t); this._avgLastFrameId = frameId; }
    } else if (t - this._avgLastRefresh >= this._avgRefreshSecs) {
      this._recomputeAvgCache(t);
      this._avgLastRefresh = t;
    }
    return this._avgCache[metric] || null;
  }

  _recomputeAvgCache(now) {
    const B = this._avgBuffers;
    const live = this._avgWindowSecs <= 0;
    // In Live mode use only the most recent sample; otherwise the trailing time window.
    const within = (buf) => {
      if (!buf.length) return [];
      if (live) return buf.slice(-1);
      const cutoff = now - this._avgWindowSecs;
      let i = buf.length;
      while (i > 0 && buf[i - 1].t >= cutoff) i--;
      return buf.slice(i);
    };
    const MIN_N = live ? 1 : 5; // need a few samples for a stable window average

    // Pitch — mean Hz plus min/max and semitone range (range is the most training-useful cue).
    {
      const s = within(B.pitch);
      if (s.length >= MIN_N) {
        let sum = 0, min = Infinity, max = -Infinity;
        for (const p of s) { sum += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
        const meanHz = sum / s.length;
        const rangeSemitones = (min > 0 && max > 0) ? 12 * Math.log2(max / min) : 0;
        this._avgCache.pitch = { n: s.length, meanHz, minHz: min, maxHz: max, rangeSemitones };
      } else this._avgCache.pitch = null;
    }

    // Resonance — mean F1/F2 and a bright/neutral/dark descriptor (from F2, matching the
    // resonance-score logic in the analyzer).
    {
      const s = within(B.resonance);
      if (s.length >= MIN_N) {
        let f1 = 0, f2 = 0;
        for (const p of s) { f1 += p.f1; f2 += p.f2; }
        const meanF1 = f1 / s.length, meanF2 = f2 / s.length;
        const descriptor = meanF2 >= 1900 ? 'Bright' : meanF2 >= 1500 ? 'Neutral' : 'Dark';
        this._avgCache.resonance = { n: s.length, meanF1, meanF2, descriptor };
      } else this._avgCache.resonance = null;
    }

    // Attack — mean blended hardness plus the two sub-cues (rise-rate vs abruptness).
    {
      const s = within(B.attack);
      if (s.length >= MIN_N) {
        let v = 0, rise = 0, abrupt = 0;
        for (const p of s) { v += p.v; rise += (p.rise || 0); abrupt += (p.abrupt || 0); }
        const mean = v / s.length;
        const descriptor = mean <= 0.15 ? 'Soft' : mean <= 0.55 ? 'Medium' : 'Hard';
        this._avgCache.attack = { n: s.length, mean, meanRise: rise / s.length, meanAbrupt: abrupt / s.length, descriptor };
      } else this._avgCache.attack = null;
    }

    // Weight — mean blended heaviness plus per-cue means (spectral tilt, H1–H2 in dB).
    {
      const s = within(B.weight);
      if (s.length >= MIN_N) {
        let v = 0, tilt = 0, h1h2 = 0;
        for (const p of s) { v += p.v; tilt += p.tilt; h1h2 += p.h1h2; }
        const mean = v / s.length;
        const descriptor = mean <= 0.35 ? 'Light' : mean <= 0.6 ? 'Balanced' : 'Heavy';
        this._avgCache.weight = { n: s.length, mean, meanTilt: tilt / s.length, meanH1H2: h1h2 / s.length, descriptor };
      } else this._avgCache.weight = null;
    }
  }

  // ---- Readout formatters (shared by HUD meters, expanded cards, and focus popup) ----

  _pitchReadout(rich = false) {
    const s = this._avgSummary('pitch');
    if (!s) return (rich || this.pitchDisplayMode === 'hz') ? '— Hz' : '—';
    const note = this._pitchHzToNoteLabel(s.meanHz);
    if (rich) return `${Math.round(s.meanHz)} Hz · ${note} · ±${(s.rangeSemitones / 2).toFixed(1)}st`;
    switch (this.pitchDisplayMode) {
      case 'note': return note;
      case 'range': return `${s.rangeSemitones.toFixed(1)} st`;
      default: return `${Math.round(s.meanHz)} Hz`;
    }
  }

  _resonanceReadout(format) {
    const s = this._avgSummary('resonance');
    if (!s) return '—';
    const f1 = Math.round(s.meanF1), f2 = Math.round(s.meanF2);
    if (format === 'popup') return `F1: ${f1} Hz  F2: ${f2} Hz`;
    if (format === 'card') return `${s.descriptor} · F2 ${f2}`;
    return `${f1}/${f2}`; // compact HUD
  }

  _attackReadout() {
    const s = this._avgSummary('attack');
    if (!s) return '—';
    const v = this.attackMode === 'rise' ? s.meanRise
            : this.attackMode === 'abrupt' ? s.meanAbrupt
            : s.mean;
    const d = v <= 0.15 ? 'Soft' : v <= 0.55 ? 'Medium' : 'Hard';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  _weightReadout() {
    const s = this._avgSummary('weight');
    if (!s) return '—';
    let v;
    if (this.weightMode === 'tilt') v = s.meanTilt;
    else if (this.weightMode === 'h1h2') v = 1 - normalizeAgainstRange(s.meanH1H2, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    else v = s.mean;
    v = Math.max(0, Math.min(1, v));
    const d = v <= 0.35 ? 'Light' : v <= 0.6 ? 'Balanced' : 'Heavy';
    return `${Math.round(v * 100)}% · ${d}`;
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
    h.vowels.push(m.vowel);
    h.attack.push(m.attack);
    h.weight.push(m.weight);

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
  }

  _sizeExpandedCanvases() {
    const ids = ['expCanvasPitch', 'expCanvasResonance', 'expCanvasBounce',
                 'expCanvasVowels', 'expCanvasAttack', 'expCanvasWeight'];
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
    this._updateAttackOrb(this.analyzer.metrics.attack);

    const m = this.analyzer.metrics;

    if (this.metersExpanded) {
      // Update expanded card values — windowed averages (visuals below stay live)
      const pEl = document.getElementById('expValPitch');
      if (pEl) pEl.textContent = this._pitchReadout(true);
      const rEl = document.getElementById('expValResonance');
      if (rEl) rEl.textContent = this._resonanceReadout('card');
      const atkEl = document.getElementById('expValAttack');
      if (atkEl) atkEl.textContent = this._attackReadout();
      const wtEl = document.getElementById('expValWeight');
      if (wtEl) wtEl.textContent = this._weightReadout();

      // Render each card canvas
      this._drawLineGraph('expCanvasPitch', this._metricHistory.pitch, '#c084fc', 60, 400, true);
      this._drawSpectrogram('expCanvasResonance');
      this._drawLineGraph('expCanvasBounce', this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
      this._drawVowelPlot('expCanvasVowels');
      this._drawOrb('expCanvasAttack', this._attackOrb.solidity, '#2ec4b6');
      this._drawOrb('expCanvasWeight', m.weight, '#e06c9f');
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

  // Advance the vocal-attack orb's gas→solid animation. A rising edge of the (decaying) attack
  // impulse marks a fresh onset; the orb then condenses toward that hardness at a speed
  // proportional to it — a hard attack snaps solid almost instantly, a soft attack blooms
  // slowly — before evaporating back to gas, ready for the next onset. The condensation *speed*
  // (and the solidity it reaches) is the readable signal.
  _updateAttackOrb(attackVal) {
    const st = this._attackOrb;
    const now = performance.now();
    const dt = st.lastT ? Math.min(0.1, (now - st.lastT) / 1000) : 0.016;
    st.lastT = now;
    if (attackVal > st.prevAttack + 0.02) st.hardness = attackVal; // fresh onset captured
    st.prevAttack = attackVal;
    const a = st.hardness;
    if (a > 0.01 && st.solidity < a - 0.005) {
      const rate = Math.min(1, (1.5 + a * 12) * dt); // speed ∝ hardness
      st.solidity += (a - st.solidity) * rate;
    } else {
      st.solidity += (0 - st.solidity) * Math.min(1, 2.2 * dt); // evaporate back to gas
      st.hardness *= 0.96;
    }
  }

  // Draw a single "gas → solid" orb for solidity ∈ [0,1]: a wide faint glow when gassy, a bright
  // dense core with a crisp rim when solid. Used for the Vocal Attack and Weight visualizations
  // (reads the canvas size, so it scales for both the small cards and the larger focus popup).
  _drawOrb(canvasId, solidity, color) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const s = Math.max(0, Math.min(1, solidity || 0));
    const cx = w / 2, cy = h / 2;
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const maxR = Math.min(w, h) * 0.42;

    // Halo — wide and faint when gassy, tighter and brighter when solid
    const haloR = maxR * (1.0 + (1 - s) * 0.8);
    const haloA = 0.08 + s * 0.22;
    const halo = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, haloR);
    halo.addColorStop(0, rgba(haloA));
    halo.addColorStop(0.5, rgba(haloA * 0.4));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Core — emerges from the gas and brightens as it solidifies
    const coreR = maxR * (0.30 + s * 0.55);
    const coreA = 0.12 + s * 0.82;
    const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(Math.min(1, coreA + 0.15)));
    core.addColorStop(0.7, rgba(coreA));
    core.addColorStop(1, rgba(coreA * (0.2 + s * 0.5)));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Rim — only crisp once solid
    if (s > 0.12) {
      ctx.strokeStyle = rgba(0.2 + s * 0.6);
      ctx.lineWidth = (0.5 + s * 1.5) * (window.devicePixelRatio || 1);
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
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
      vowels: 'A vowel space plot (F1 vs F2) showing the brightness or darkness of vowel sounds like "EE" and "AH." Tracks resonance shifts during articulation.',
      attack: 'Vocal attack measures onset hardness — how steeply your voice rises into phonation. High = crisp glottal onsets; low = soft, breathy, gradual starts.',
      weight: 'Vocal weight is perceived heaviness from spectral tilt. High = thick, heavy, buzzy tone; low = light, bright, breathy tone.',
    };

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
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

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
    };
    el.style.color = colors[metric] || '#fff';

    switch (metric) {
      case 'pitch': el.textContent = this._pitchReadout(true); break;
      case 'resonance': el.textContent = this._resonanceReadout('popup'); break;
      // Bounce/Vowels: percentage readouts removed — the chart below is the readout.
      case 'bounce': el.textContent = ''; break;
      case 'vowels': el.textContent = ''; break;
      case 'attack': el.textContent = this._attackReadout(); break;
      case 'weight': el.textContent = this._weightReadout(); break;
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
      case 'vowels':
        this._drawVowelPlot(canvasId);
        break;
      case 'attack':
        this._drawOrb(canvasId, this._attackOrb.solidity, '#2ec4b6');
        break;
      case 'weight':
        this._drawOrb(canvasId, this.analyzer.metrics.weight, '#e06c9f');
        break;
    }
  }
}

// Initialize if in main UI, export for testing harness
export const game = document.getElementById('app') ? new VoxBallGame() : null;

// Expose the live instance for host integrations (e.g. the Wear OS watch
// shell, which seeds vibration rules and reads alert state). Additive only —
// has no effect on the standalone web app.
if (typeof window !== 'undefined' && game) window.voxGame = game;
