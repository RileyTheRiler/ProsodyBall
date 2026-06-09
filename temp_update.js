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

      for (let i = 0; i < this.frequencyData.length; i++) {
        // Convert Decibels to Linear Magnitude for proper calibration scaling
        const linearMag = Math.pow(10, this.frequencyData[i] / 20);
        this.noiseSpectralProfile[i] += linearMag;

        const freqHz = i * fftBinHz;
        const aWeight = this._aWeightGain(freqHz);
        const powerA = linearMag * linearMag * aWeight;
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

    const sumBandPowerAWeighted = (loHz, hiHz) => {
      if (hiHz <= loHz) return 0;
      const startBin = Math.max(0, Math.floor(loHz / fftBinHz));
      const endBin = Math.min(fData.length - 1, Math.ceil(hiHz / fftBinHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        const freqHz = i * fftBinHz;
        const mag = Math.pow(10, fData[i] / 20);
        sum += mag * mag * this._aWeightGain(freqHz);
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

    // 1. BOUNCE — pitch variation
    if (this.pitchHistory.length > 3) {
      const len = this.pitchHistory.length;
      let sum = 0;
      for (let i = 0; i < len; i++) sum += this.pitchHistory[i];
      const mean = sum / len;

      let sqSum = 0;
      for (let i = 0; i < len; i++) {
        const diff = this.pitchHistory[i] - mean;
        sqSum += diff * diff;
      }
      const variance = sqSum / len;
      this.metrics.bounce = Math.min(1, Math.sqrt(variance) / BOUNCE_NORM_DIVISOR);
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
      this.metrics.tempo = Math.min(1, transitions / TEMPO_TRANSITION_DIVISOR);
    }

    // 3. VOWEL ELONGATION — sustained voicing WITH vowel-like formants
    //    Uses vowelLikelihood to distinguish real vowels from "sss" or "mmm"
    const dynamicSustainThreshold = this.energyPercentiles.p50 + baseEnergyRange * VOWEL_SUSTAIN_MULT;
    const isVowelSound = gatedRms > dynamicSustainThreshold && pitch > 0 && this.vowelLikelihood > 0.3;
    if (isVowelSound) {
      this.sustainedDuration += dt * (0.5 + this.vowelLikelihood * 0.5); // stronger vowels accumulate faster
    } else {
      this.sustainedDuration *= 0.85;
    }
    this.metrics.vowel = Math.min(1, Math.max(0, this.sustainedDuration - VOWEL_ONSET_SECS) / VOWEL_SATURATION_SECS);

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
    this.metrics.syllable = this.syllableImpulse;

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
      this.metrics.tempo *= 0.98;
    } else {
      this.metrics.bounce *= confidenceGate * pitchGate;
      this.metrics.tempo *= voicedGate;
    }

    this.metrics.articulation *= Math.max(0.25, voicedGate * 0.8 + confidenceGate * 0.2);
    this.metrics.syllable *= voicedGate;
    this.metrics.attack *= Math.max(0.2, voicedGate);

    const pitchRange = Math.max(50, this.pitchProfile.max - this.pitchProfile.min);
    this.metrics.pitch = pitch > 0 ? Math.max(0, Math.min(1, (pitch - this.pitchProfile.min) / pitchRange)) : this.metrics.pitch * 0.95;
    this.metrics.energy = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1.1);
    this.metrics.resonance = this.smoothResonance;

    // 7. WEIGHT — perceived heaviness (1=heavy/thick, 0=light/breathy). Reuses the
    //    spectral-tilt analysis (spectralWeight: 0=heavy,1=light) with a small F2 blend.
    const heavinessTilt = 1 - this.spectralWeight;
    let f2Heavy = 0.5, f2W = 0;
    if (this.formantConfidence > 0.3) {
      f2Heavy = clamp01((2400 - this.smoothF2) / 1300); // low F2 = heavier/darker
      f2W = WEIGHT_F2_BLEND;
    }
    // H1-H2 breathiness cue → lightness; only blended in when a clean F0 gives a trustworthy estimate.
    const h1h2Light = normalizeAgainstRange(this.h1h2SmoothedDb, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    const weightTarget = computeWeightTarget({
      tiltHeaviness: heavinessTilt,
      tiltWeight: WEIGHT_TILT_BASE,
      h1h2Heaviness: 1 - h1h2Light,
      h1h2Weight: WEIGHT_H1H2_BLEND * this.h1h2Confidence,
      f2Heaviness: f2Heavy,
      f2Weight: f2W
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