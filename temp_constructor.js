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
      bounce: 0, tempo: 0, vowel: 0,
      articulation: 0, syllable: 0,
      pitch: 0, energy: 0, resonance: 0,
      attack: 0, weight: 0
    };
    this.frameConfidence = 0; // overall frame confidence for game-level gating
    this.wasLastFrameReliable = false;
    this.noiseSpectralProfile = null;
  }